/**
 * embedding / rerank 共用的 HTTP 层:URL 归一化、超时、重试、并发池、错误分类。
 *
 * 浏览器直连第三方端点,失败原因必须能区分 —— 用户看到「请求失败」是没法自救的,
 * 看到「CORS 或网络不可达」才知道该去开代理。
 */

export type EndpointErrorKind =
  /** 端点/模型没填 */
  | 'config'
  /** fetch 抛 TypeError:CORS 被拒、DNS 失败、连接被拒,浏览器不区分这三者 */
  | 'network'
  | 'timeout'
  /** 401 / 403 */
  | 'auth'
  /** 其余非 2xx */
  | 'http'
  /** 2xx 但响应体不是预期结构 */
  | 'parse';

export class EndpointError extends Error {
  readonly kind: EndpointErrorKind;
  readonly status: number | undefined;

  constructor(kind: EndpointErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'EndpointError';
    this.kind = kind;
    this.status = status;
  }
}

/** 给用户看的中文说明,连通性测试与召回失败提示共用。 */
export function describeError(e: unknown): string {
  if (!(e instanceof EndpointError)) return e instanceof Error ? e.message : String(e);
  switch (e.kind) {
    case 'config':
      return e.message;
    case 'network':
      return '无法连接:可能是 CORS 被拒、地址不可达或服务未启动。若服务商不放 CORS 头,可在 SillyTavern 的 config.yaml 里开启 enableCorsProxy,再把地址改走 /proxy/。';
    case 'timeout':
      return '请求超时。可在设置里调大超时秒数,或减小批量大小。';
    case 'auth':
      return `鉴权失败(HTTP ${e.status}):API Key 不正确或无权访问该模型。`;
    case 'http':
      return `服务返回 HTTP ${e.status}:${e.message}`;
    case 'parse':
      return `响应格式不符合预期:${e.message}`;
  }
}

export interface EndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutSec: number;
  retries: number;
}

/**
 * 拼出最终请求地址。
 *
 * 用户填 `https://x.com`、`https://x.com/v1`、`https://x.com/v1/` 都能用;
 * 若已经填到具体路径(以 `/embeddings` 或 `/rerank` 结尾)则原样使用 —— 这是给
 * 路径不走 `/v1` 的自建服务留的逃生口。
 */
export function resolveEndpointUrl(baseUrl: string, path: '/embeddings' | '/rerank'): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new EndpointError('config', '端点地址未配置');
  if (base.endsWith(path)) return base;
  if (/\/v\d+$/.test(base)) return base + path;
  return `${base}/v1${path}`;
}

/** 这些错误重试没有意义:配置错、鉴权错、请求本身不合法。 */
function isRetryable(e: unknown): boolean {
  if (!(e instanceof EndpointError)) return false;
  if (e.kind === 'network' || e.kind === 'timeout') return true;
  // 429 与 5xx 值得退避重试
  return e.kind === 'http' && (e.status === 429 || (e.status ?? 0) >= 500);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 单次请求:超时用 AbortController,外部 signal 取消也走同一条链路。 */
async function postJsonOnce(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSec) * 1000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    // 外部主动取消要原样抛出,不能被当成超时吞掉
    if (signal?.aborted) throw e;
    if (controller.signal.aborted) throw new EndpointError('timeout', `请求超过 ${timeoutSec}s`);
    throw new EndpointError('network', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new EndpointError('auth', detail, res.status);
    }
    throw new EndpointError('http', detail || res.statusText, res.status);
  }

  try {
    return await res.json();
  } catch (e) {
    throw new EndpointError('parse', e instanceof Error ? e.message : String(e));
  }
}

/** 带指数退避重试的 POST。retries 是重试次数,不含首次。 */
export async function postJson(
  url: string,
  cfg: EndpointConfig,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const attempts = Math.max(0, cfg.retries) + 1;
  let last: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await postJsonOnce(url, cfg.apiKey, body, cfg.timeoutSec, signal);
    } catch (e) {
      last = e;
      if (signal?.aborted || i === attempts - 1 || !isRetryable(e)) throw e;
      await sleep(Math.min(8000, 500 * 2 ** i));
    }
  }
  throw last;
}

/**
 * 并发池:批次再多也只同时在飞 poolSize 个请求。
 * 结果按输入顺序回填,调用方不必自己对齐下标。
 */
export async function runPool<T, R>(
  items: T[],
  poolSize: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]!, i);
    }
  };

  await Promise.all(Array.from({ length: Math.min(poolSize, items.length) }, run));
  return out;
}

/**
 * 按条数与总字符数双上限切批。
 * 单条就超字符上限时独占一批 —— 宁可让服务端拒绝,也不能静默丢内容。
 */
export function batchByCharBudget(
  texts: string[],
  maxCount: number,
  maxChars: number,
): Array<{ indices: number[]; texts: string[] }> {
  const batches: Array<{ indices: number[]; texts: string[] }> = [];
  let cur: { indices: number[]; texts: string[] } = { indices: [], texts: [] };
  let chars = 0;

  texts.forEach((t, i) => {
    const len = t.length;
    if (cur.indices.length > 0 && (cur.indices.length >= maxCount || chars + len > maxChars)) {
      batches.push(cur);
      cur = { indices: [], texts: [] };
      chars = 0;
    }
    cur.indices.push(i);
    cur.texts.push(t);
    chars += len;
  });

  if (cur.indices.length) batches.push(cur);
  return batches;
}
