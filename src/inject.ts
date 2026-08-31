/**
 * 召回编排与提示词注入。
 *
 * 由 generate_interceptor 阻塞式调用:ST 会 await 拦截器,所以整条管线跑完再放行,
 * 注入必定赶得上本轮生成。
 */

import { retrieve, type RetrievalHit, type RetrievalParams } from './retrieve/pipeline.ts';
import { getContext, PROMPT_POSITION, PROMPT_ROLE, type StChatMessage } from './st/context.ts';
import { settings } from './settings.ts';
import { lastDebug, lastInjected } from './state/runtime.ts';

/** 注入槽的 key。同一 key 重复 set 即覆盖,写空串即清空。 */
export const INJECT_KEY = 'st_better_rag_db';

const HEADER = '# 知识库参考\n以下条目由知识库检索得到,与当前对话相关,可作为设定依据:';
const SEPARATOR = '\n\n---\n\n';

export const DEFAULT_DEPTH = 4;

/**
 * ST 的注入深度上限是 MAX_INJECTION_DEPTH(10000);用户编辑输入框时会出现临时非法值,运行时兜住。
 *
 * 空串必须当非法处理:`Number('')` 是 0,而 0 是合法深度 —— 用户刚清空输入框就把注入
 * 位置悄悄挪到最末尾,是个很难察觉的行为变化。
 */
export function normalizeDepth(depth: unknown): number {
  if (typeof depth === 'string' && !depth.trim()) return DEFAULT_DEPTH;
  const n = Number(depth);
  if (!Number.isFinite(n)) return DEFAULT_DEPTH;
  return Math.min(10000, Math.max(0, Math.floor(n)));
}

export function formatHits(hits: RetrievalHit[]): string {
  if (!hits.length) return '';
  // document 本身已是「标题\n正文」,直接用分隔符串起来即可
  return `${HEADER}\n\n${hits.map(h => h.document).join(SEPARATOR)}`;
}

export function applyInjection(text: string): void {
  const ctx = getContext();
  if (!ctx?.setExtensionPrompt) return;
  ctx.setExtensionPrompt(
    INJECT_KEY,
    text,
    PROMPT_POSITION.IN_CHAT,
    normalizeDepth(settings.value.injection.depth),
    false,
    PROMPT_ROLE.SYSTEM,
    null,
  );
  lastInjected.value = text;
}

export function clearInjection(): void {
  applyInjection('');
}

/** 取最近 n 条非系统消息拼成查询。空消息与系统提示不参与,否则会把噪声喂进检索。 */
export function buildQuery(chat: StChatMessage[], n: number): string {
  const usable = chat.filter(m => !m.is_system && typeof m.mes === 'string' && m.mes.trim());
  return usable
    .slice(-Math.max(1, n))
    .map(m => m.mes!.trim())
    .join('\n');
}

function paramsFromSettings(): RetrievalParams {
  const r = settings.value.retrieval;
  return {
    bm25TopN: r.bm25TopN,
    vectorTopN: r.vectorTopN,
    fuseTopN: r.fuseTopN,
    rerankTopK: r.rerankTopK,
    rrfK: r.rrfK,
    fusionMode: r.fusionMode,
    weights: r.weights,
    bm25: r.bm25,
    rerankThreshold: r.rerankThreshold,
    fuseThreshold: r.fuseThreshold,
    charBudget: settings.value.injection.charBudget,
  };
}

/**
 * 跑一轮召回并写注入槽。
 *
 * 永不抛错 —— 任何检索异常都只会导致本轮无注入,绝不能阻断对话。
 */
export async function runRecall(signal?: AbortSignal): Promise<void> {
  const s = settings.value;
  if (!s.enabled) {
    clearInjection();
    return;
  }

  const kbs = s.kbs.filter(k => k.enabled).map(k => ({ id: k.id, name: k.name }));
  if (!kbs.length) {
    clearInjection();
    return;
  }

  const ctx = getContext();
  if (!ctx) return;

  try {
    const query = buildQuery(ctx.chat ?? [], s.retrieval.queryMessageCount);
    const outcome = await retrieve(query, {
      params: paramsFromSettings(),
      embedCfg: s.embedding,
      rerankCfg: s.rerank,
      kbs,
      ...(signal ? { signal } : {}),
    });
    lastDebug.value = outcome.debug;
    applyInjection(formatHits(outcome.hits));
  } catch (e) {
    console.error('[srdb] 召回异常,本轮不注入', e);
    clearInjection();
  }
}

/** 只有真正要发给模型的生成类型才召回;继续/impersonate 之类不重复跑。 */
export function shouldRecallForType(type: string | undefined): boolean {
  return type !== 'quiet' && type !== 'impersonate';
}
