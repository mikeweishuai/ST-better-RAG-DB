/**
 * OpenAI 兼容的 embedding 客户端(`{base}/v1/embeddings`)。
 *
 * 覆盖 Jina / Xinference / Ollama / vLLM / 硅基流动等一众实现:请求体同为
 * `{ model, input: string[] }`,响应体同为 `{ data: [{ index, embedding }] }`。
 */

import { l2Normalize } from '../engine/quantize.ts';
import {
  EndpointError,
  batchByCharBudget,
  postJson,
  resolveEndpointUrl,
  runPool,
  type EndpointConfig,
} from './http.ts';

/** 单批条数上限与字符上限。字符上限防止长词条把请求体撑爆。 */
export const EMBED_BATCH_COUNT = 32;
export const EMBED_BATCH_CHARS = 32_000;
export const EMBED_CONCURRENCY = 3;

/** 有些服务在 encoding_format 未指定时返回 base64,这里一并兼容。 */
function decodeBase64Floats(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function toVector(embedding: unknown): Float32Array {
  if (Array.isArray(embedding)) return Float32Array.from(embedding as number[]);
  if (typeof embedding === 'string') return decodeBase64Floats(embedding);
  throw new EndpointError('parse', 'data[].embedding 既不是数组也不是 base64 字符串');
}

/** 解析一批的响应,按 data[].index 回位 —— 不能假设服务端保序。 */
function parseBatch(payload: unknown, expected: number): Float32Array[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new EndpointError('parse', '响应缺少 data 数组');
  if (data.length !== expected) {
    throw new EndpointError('parse', `期望 ${expected} 条向量,实得 ${data.length} 条`);
  }

  const out = new Array<Float32Array>(expected);
  data.forEach((row, i) => {
    const r = row as { index?: unknown; embedding?: unknown };
    const at = typeof r.index === 'number' ? r.index : i;
    if (at < 0 || at >= expected) throw new EndpointError('parse', `data[].index 越界:${at}`);
    out[at] = toVector(r.embedding);
  });

  const missing = out.findIndex(v => !v);
  if (missing >= 0) throw new EndpointError('parse', `data[].index 有缺口:${missing}`);
  return out;
}

/**
 * 批量向量化。返回值与入参一一对应,且已 L2 归一化(量化入库与查询扫描都依赖这一点)。
 * 任一批失败即整体失败 —— 半份索引比没有索引更糟。
 */
export async function embedTexts(
  texts: string[],
  cfg: EndpointConfig,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  if (!texts.length) return [];
  if (!cfg.model.trim()) throw new EndpointError('config', 'Embedding 模型未配置');

  const url = resolveEndpointUrl(cfg.baseUrl, '/embeddings');
  const batches = batchByCharBudget(texts, EMBED_BATCH_COUNT, EMBED_BATCH_CHARS);

  let done = 0;
  const results = await runPool(batches, EMBED_CONCURRENCY, async batch => {
    const payload = await postJson(url, cfg, { model: cfg.model, input: batch.texts }, signal);
    const vectors = parseBatch(payload, batch.texts.length);
    done += batch.texts.length;
    onProgress?.(done, texts.length);
    return { indices: batch.indices, vectors };
  });

  const out = new Array<Float32Array>(texts.length);
  for (const { indices, vectors } of results) {
    indices.forEach((globalIndex, i) => {
      out[globalIndex] = l2Normalize(vectors[i]!);
    });
  }
  return out;
}

/** 单条查询向量。 */
export async function embedQuery(
  text: string,
  cfg: EndpointConfig,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const [v] = await embedTexts([text], cfg, signal);
  if (!v) throw new EndpointError('parse', '未取到查询向量');
  return v;
}

/** 连通性测试:发一条极短文本,回报维度。 */
export async function testEmbedding(cfg: EndpointConfig): Promise<{ dim: number }> {
  const v = await embedQuery('ping', cfg);
  return { dim: v.length };
}
