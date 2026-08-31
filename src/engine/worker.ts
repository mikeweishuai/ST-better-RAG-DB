/**
 * 索引构建 Worker。
 *
 * 分词、倒排、量化都是 CPU 密集的纯计算,放主线程会在导入几千条时把界面卡死。
 * embedding 请求留在主线程发(复用设置与错误提示),向量回来后交给这里量化。
 */

import { buildPostings, type PostingRow } from './bm25.ts';
import { quantize } from './quantize.ts';

export interface PostingsRequest {
  id: number;
  type: 'postings';
  documents: string[];
}

export interface QuantizeRequest {
  id: number;
  type: 'quantize';
  /** 已 L2 归一化的向量,扁平存放:第 i 条占 [i*dim, (i+1)*dim) */
  flat: Float32Array;
  dim: number;
}

export type WorkerRequest = PostingsRequest | QuantizeRequest;

export interface PostingsResult {
  rows: PostingRow[];
  docLens: number[];
  avgdl: number;
}

export interface QuantizeResult {
  /** 扁平量化结果,与入参同样的分段方式 */
  matrix: Int8Array;
  scales: Float32Array;
}

export type WorkerResponse =
  | { id: number; ok: true; type: 'postings'; result: PostingsResult }
  | { id: number; ok: true; type: 'quantize'; result: QuantizeResult }
  | { id: number; ok: false; error: string };

function handle(req: WorkerRequest): WorkerResponse {
  try {
    if (req.type === 'postings') {
      return { id: req.id, ok: true, type: 'postings', result: buildPostings(req.documents) };
    }

    const { flat, dim } = req;
    const count = dim > 0 ? Math.floor(flat.length / dim) : 0;
    const matrix = new Int8Array(count * dim);
    const scales = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const { q, scale } = quantize(flat.subarray(i * dim, (i + 1) * dim));
      matrix.set(q, i * dim);
      scales[i] = scale;
    }
    return { id: req.id, ok: true, type: 'quantize', result: { matrix, scales } };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const res = handle(ev.data);
  // 量化结果的两块 buffer 转移所有权,避免几十 MB 的结构化克隆
  const transfer =
    res.ok && res.type === 'quantize'
      ? [res.result.matrix.buffer, res.result.scales.buffer]
      : [];
  (self as unknown as Worker).postMessage(res, transfer as Transferable[]);
};
