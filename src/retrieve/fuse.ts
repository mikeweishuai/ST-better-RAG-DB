/**
 * 多路召回结果融合。
 *
 * 默认 RRF:BM25 分数与余弦相似度尺度不可比,min-max 归一化对分布极敏感
 * (一个离群高分能把其余全压平),RRF 只用排名,无需调标。
 * 加权归一化作为调试台的对照模式保留。
 */

export interface Hit {
  o: number;
  score: number;
}

/** 一路召回的结果,按 score 降序。name 用于调试台标注来源。 */
export interface Channel {
  name: string;
  hits: Hit[];
}

export interface FusedHit {
  o: number;
  score: number;
  /** 该条在各路里的名次(1 起,未命中则缺席),供调试台标「只有 BM25 命中」。 */
  ranks: Record<string, number>;
}

export const DEFAULT_RRF_K = 60;

/** `score = Σ 1/(k + rank)`,rank 从 1 起。 */
export function rrf(channels: Channel[], topN: number, k: number = DEFAULT_RRF_K): FusedHit[] {
  const acc = new Map<number, FusedHit>();

  for (const ch of channels) {
    ch.hits.forEach((hit, i) => {
      const rank = i + 1;
      let entry = acc.get(hit.o);
      if (!entry) acc.set(hit.o, (entry = { o: hit.o, score: 0, ranks: {} }));
      entry.score += 1 / (k + rank);
      entry.ranks[ch.name] = rank;
    });
  }

  return [...acc.values()].sort((a, b) => b.score - a.score || a.o - b.o).slice(0, topN);
}

/**
 * 对照模式:各路分数各自 min-max 归一化后加权求和。
 * 单路内全部同分时该路整体记 1(而非 0/0)。
 */
export function weightedNormalized(
  channels: Channel[],
  weights: Record<string, number>,
  topN: number,
): FusedHit[] {
  const acc = new Map<number, FusedHit>();

  for (const ch of channels) {
    if (!ch.hits.length) continue;
    const w = weights[ch.name] ?? 1;
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of ch.hits) {
      if (h.score < lo) lo = h.score;
      if (h.score > hi) hi = h.score;
    }
    const span = hi - lo;

    ch.hits.forEach((hit, i) => {
      const norm = span > 0 ? (hit.score - lo) / span : 1;
      let entry = acc.get(hit.o);
      if (!entry) acc.set(hit.o, (entry = { o: hit.o, score: 0, ranks: {} }));
      entry.score += w * norm;
      entry.ranks[ch.name] = i + 1;
    });
  }

  return [...acc.values()].sort((a, b) => b.score - a.score || a.o - b.o).slice(0, topN);
}
