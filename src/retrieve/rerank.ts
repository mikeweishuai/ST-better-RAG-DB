/**
 * OpenAI 兼容的 rerank 客户端(`{base}/v1/rerank`)。
 *
 * 请求体 `{ model, query, documents: string[] }`,响应体
 * `{ results: [{ index, relevance_score }] }`(部分实现字段名为 score,一并兼容)。
 *
 * 分批时每批都要重发 query,批内 index 是批内下标,必须映射回全局下标后再合并。
 */

import {
  EndpointError,
  batchByCharBudget,
  postJson,
  resolveEndpointUrl,
  runPool,
  type EndpointConfig,
} from './http.ts';

export const RERANK_BATCH_COUNT = 32;
export const RERANK_BATCH_CHARS = 48_000;
export const RERANK_CONCURRENCY = 3;

export interface RerankResult {
  /** 在传入 documents 数组中的下标 */
  index: number;
  score: number;
}

function parseBatch(payload: unknown, expected: number): Array<{ index: number; score: number }> {
  const raw = payload as { results?: unknown; data?: unknown };
  const results = Array.isArray(raw?.results) ? raw.results : Array.isArray(raw?.data) ? raw.data : null;
  if (!results) throw new EndpointError('parse', '响应缺少 results 数组');

  return results.map((row, i) => {
    const r = row as { index?: unknown; relevance_score?: unknown; score?: unknown };
    const index = typeof r.index === 'number' ? r.index : i;
    const score = typeof r.relevance_score === 'number' ? r.relevance_score : r.score;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new EndpointError('parse', 'results[] 缺少 relevance_score / score');
    }
    if (index < 0 || index >= expected) throw new EndpointError('parse', `results[].index 越界:${index}`);
    return { index, score };
  });
}

/**
 * 精排。返回按 score 降序的结果,index 指向传入的 documents。
 *
 * 注意:调用方必须自行处理失败降级 —— rerank 分数与融合分数尺度不可比,
 * 降级为融合序时不能沿用 rerank 的准入阈值。
 */
export async function rerankDocuments(
  query: string,
  documents: string[],
  cfg: EndpointConfig,
  signal?: AbortSignal,
): Promise<RerankResult[]> {
  if (!documents.length) return [];
  if (!cfg.model.trim()) throw new EndpointError('config', 'Rerank 模型未配置');

  const url = resolveEndpointUrl(cfg.baseUrl, '/rerank');
  const batches = batchByCharBudget(documents, RERANK_BATCH_COUNT, RERANK_BATCH_CHARS);

  const perBatch = await runPool(batches, RERANK_CONCURRENCY, async batch => {
    const payload = await postJson(
      url,
      cfg,
      { model: cfg.model, query, documents: batch.texts, top_n: batch.texts.length },
      signal,
    );
    // 批内下标 → 全局下标
    return parseBatch(payload, batch.texts.length).map(r => ({
      index: batch.indices[r.index]!,
      score: r.score,
    }));
  });

  return perBatch.flat().sort((a, b) => b.score - a.score || a.index - b.index);
}

/** 连通性测试:两条明显不同相关度的文档,回报是否把相关的排在前面。 */
export async function testRerank(cfg: EndpointConfig): Promise<{ ordered: boolean }> {
  const results = await rerankDocuments('苹果', ['苹果是一种水果', '柴油发动机的维修手册'], cfg);
  return { ordered: results[0]?.index === 0 };
}
