/**
 * BM25。
 *
 * 倒排表按 term 分行存(见 db.ts 的 postings 表),查询时只读 query 分词后那几十个 term 的行,
 * 不反序列化整个索引 —— 这是纯前端能在每轮生成前跑 BM25 的前提。
 */

import { termFrequencies, tokenize } from './tokenize.ts';

export interface Bm25Params {
  k1: number;
  b: number;
}

export const DEFAULT_BM25_PARAMS: Bm25Params = { k1: 1.2, b: 0.75 };

/** 倒排表一行:一个 term 在库内的全部命中。`o` 是 chunk 序号,`tf` 是词频。 */
export interface PostingRow {
  term: string;
  df: number;
  entries: Array<{ o: number; tf: number }>;
}

/** 打分需要的库级统计量。docLens 按 chunk 序号索引。 */
export interface Bm25Stats {
  /** 文档总数 */
  N: number;
  /** 平均文档长度(token 数) */
  avgdl: number;
  docLens: ArrayLike<number>;
}

export interface ScoredDoc {
  o: number;
  score: number;
}

/**
 * Lucene 口径的 IDF:`ln(1 + (N - df + 0.5) / (df + 0.5))`。
 * 加 1 保证恒正 —— 经典 Robertson 式在 df > N/2 时会转负,让高频词反向拉低得分。
 */
export function idf(N: number, df: number): number {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

/** 对给定的倒排行集合打分,返回按分数降序的前 topN。 */
export function bm25Score(
  rows: PostingRow[],
  stats: Bm25Stats,
  topN: number,
  params: Bm25Params = DEFAULT_BM25_PARAMS,
): ScoredDoc[] {
  const { k1, b } = params;
  const { N, avgdl, docLens } = stats;
  if (N <= 0 || rows.length === 0) return [];

  const acc = new Map<number, number>();
  for (const row of rows) {
    if (row.df <= 0) continue;
    const w = idf(N, row.df);
    for (const { o, tf } of row.entries) {
      const dl = docLens[o] ?? avgdl;
      // avgdl 为 0 时(空库/全空文档)退化为不做长度归一,避免 0 除
      const norm = avgdl > 0 ? 1 - b + b * (dl / avgdl) : 1;
      const contrib = (w * (tf * (k1 + 1))) / (tf + k1 * norm);
      acc.set(o, (acc.get(o) ?? 0) + contrib);
    }
  }

  return [...acc.entries()]
    .map(([o, score]) => ({ o, score }))
    .sort((x, y) => y.score - x.score || x.o - y.o)
    .slice(0, topN);
}

/** 建索引侧:一批文档 → 倒排表 + 文档长度 + avgdl。ordinal 即数组下标。 */
export function buildPostings(documents: string[]): {
  rows: PostingRow[];
  docLens: number[];
  avgdl: number;
} {
  const byTerm = new Map<string, Array<{ o: number; tf: number }>>();
  const docLens: number[] = [];

  documents.forEach((doc, o) => {
    const tokens = tokenize(doc);
    docLens.push(tokens.length);
    for (const [term, tf] of termFrequencies(tokens)) {
      let list = byTerm.get(term);
      if (!list) byTerm.set(term, (list = []));
      list.push({ o, tf });
    }
  });

  const total = docLens.reduce((a, n) => a + n, 0);
  const rows: PostingRow[] = [...byTerm.entries()].map(([term, entries]) => ({
    term,
    df: entries.length,
    entries,
  }));

  return { rows, docLens, avgdl: docLens.length ? total / docLens.length : 0 };
}
