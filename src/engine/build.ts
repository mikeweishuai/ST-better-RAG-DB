/**
 * 建索引编排:词条 → 增量 embed → 量化 → 倒排 → 落库。
 *
 * 增量的判定基准是 chunkId + docHash:id 稳定(标题 hash)保证插入新词条不会让后面各条
 * 全部失效,docHash 保证只有正文真变了才重新 embed。
 *
 * embedding 未配置时照样建 BM25 索引 —— 关键词检索不该被向量渠道的缺失拖住。
 */

import { TOKENIZER_VERSION } from './tokenize.ts';
import { buildPostingsInWorker, quantizeInWorker } from './workerClient.ts';
import {
  getAllChunks,
  getMeta,
  replaceKbIndex,
  type ChunkRecord,
} from './db.ts';
import { embedTexts } from '../retrieve/embed.ts';
import type { EndpointConfig } from '../retrieve/http.ts';
import type { KbChunk } from '../kb/types.ts';

/** 建议的单库规模上限;超出仍会建,但界面要给出内存警告。 */
export const CHUNK_COUNT_WARN = 50_000;

export type BuildPhase = 'diff' | 'embedding' | 'quantize' | 'postings' | 'writing' | 'done';

export interface BuildProgress {
  phase: BuildPhase;
  done: number;
  total: number;
}

export interface BuildReport {
  chunkCount: number;
  /** 实际调用 embedding 的条数 */
  embedded: number;
  /** 复用旧向量的条数 */
  reused: number;
  dim: number;
  /** 未配置 embedding,只建了 BM25 索引 */
  bm25Only: boolean;
}

export interface BuildOptions {
  kbId: string;
  chunks: KbChunk[];
  embedCfg: EndpointConfig;
  signal?: AbortSignal;
  onProgress?: (p: BuildProgress) => void;
}

class Cancelled extends Error {
  constructor() {
    super('索引构建已取消');
    this.name = 'Cancelled';
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof Cancelled || (e instanceof Error && e.name === 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Cancelled();
}

/** 旧向量可复用的前提:embedding 模型没换过。换了模型向量空间就变了,不可比。 */
function canReuseVectors(metaModel: string | undefined, currentModel: string): boolean {
  return !!metaModel && metaModel === currentModel;
}

export async function buildKbIndex(opts: BuildOptions): Promise<BuildReport> {
  const { kbId, chunks, embedCfg, signal, onProgress } = opts;
  const total = chunks.length;
  const bm25Only = !embedCfg.baseUrl.trim() || !embedCfg.model.trim();

  onProgress?.({ phase: 'diff', done: 0, total });
  throwIfAborted(signal);

  /* 1. 与存量对账,决定哪些条目需要重新 embed */
  const [existing, meta] = await Promise.all([getAllChunks(kbId), getMeta(kbId)]);
  const reusable = canReuseVectors(meta?.embedModel, embedCfg.model);
  const prior = new Map(existing.map(c => [c.chunkId, c]));

  const needEmbed: number[] = [];
  const carried = new Array<{ vec: Int8Array; scale: number } | null>(total).fill(null);

  chunks.forEach((chunk, i) => {
    const old = prior.get(chunk.id);
    if (reusable && old?.vec && old.docHash === chunk.docHash) {
      carried[i] = { vec: old.vec, scale: old.scale };
    } else if (!bm25Only) {
      needEmbed.push(i);
    }
  });

  /* 2. embed 变动条目 */
  let dim = reusable ? (meta?.dim ?? 0) : 0;
  let quantizedNew: { matrix: Int8Array; scales: Float32Array } | null = null;

  if (needEmbed.length) {
    onProgress?.({ phase: 'embedding', done: 0, total: needEmbed.length });
    const vectors = await embedTexts(
      needEmbed.map(i => chunks[i]!.document),
      embedCfg,
      signal,
      done => onProgress?.({ phase: 'embedding', done, total: needEmbed.length }),
    );
    throwIfAborted(signal);

    const newDim = vectors[0]?.length ?? 0;
    // 换模型或服务端换维度时,旧向量整体作废,本轮全部重新计算
    if (dim && newDim && dim !== newDim) {
      throw new Error(`向量维度从 ${dim} 变为 ${newDim},请先删除该库再重新导入`);
    }
    dim = newDim;

    onProgress?.({ phase: 'quantize', done: 0, total: needEmbed.length });
    const flat = new Float32Array(vectors.length * dim);
    vectors.forEach((v, i) => flat.set(v, i * dim));
    // flat 的 buffer 转移给 Worker,之后不可再用
    quantizedNew = await quantizeInWorker(flat, dim);
    throwIfAborted(signal);
  }

  /* 3. 倒排表(序号每次重建都重排,必须全量重算) */
  onProgress?.({ phase: 'postings', done: 0, total });
  const { rows, docLens, avgdl } = await buildPostingsInWorker(chunks.map(c => c.document));
  throwIfAborted(signal);

  /* 4. 落库 */
  onProgress?.({ phase: 'writing', done: 0, total });

  const newVecAt = new Map<number, number>();
  needEmbed.forEach((chunkIndex, order) => newVecAt.set(chunkIndex, order));

  const records: ChunkRecord[] = chunks.map((chunk, i) => {
    const fresh = newVecAt.get(i);
    let vec: Int8Array | null = carried[i]?.vec ?? null;
    let scale = carried[i]?.scale ?? 0;

    if (fresh !== undefined && quantizedNew && dim > 0) {
      vec = quantizedNew.matrix.slice(fresh * dim, (fresh + 1) * dim);
      scale = quantizedNew.scales[fresh] ?? 0;
    }

    return {
      kbId,
      ordinal: i,
      chunkId: chunk.id,
      title: chunk.title,
      text: chunk.text,
      document: chunk.document,
      docHash: chunk.docHash,
      len: docLens[i] ?? 0,
      vec,
      scale,
    };
  });

  // 正文、倒排和 ordinal 映射必须作为同一版本提交,失败时保留完整旧库。
  await replaceKbIndex(kbId, records, rows, {
    kbId,
    N: total,
    avgdl,
    dim,
    // BM25-only 重建可能留下未向量化的新条目,不能继续声称整库匹配旧模型。
    embedModel: bm25Only ? '' : embedCfg.model,
    tokenizerVersion: TOKENIZER_VERSION,
    ordinalToChunkId: chunks.map(c => c.id),
    docLens,
    updatedAt: Date.now(),
  });

  onProgress?.({ phase: 'done', done: total, total });

  return {
    chunkCount: total,
    embedded: needEmbed.length,
    reused: carried.filter(Boolean).length,
    dim,
    bm25Only,
  };
}

/**
 * 判断某库是否需要重建索引(而非仅仅重导内容)。
 * 分词口径变了倒排表整体作废;embedding 模型变了向量整体作废。
 */
export function needsRebuild(
  meta: { tokenizerVersion: number; embedModel: string; dim: number } | null,
  currentModel: string,
): boolean {
  if (!meta) return true;
  if (meta.tokenizerVersion !== TOKENIZER_VERSION) return true;
  return !!currentModel && (meta.embedModel !== currentModel || meta.dim === 0);
}
