/**
 * 向量的 int8 对称量化。
 *
 * 浏览器里没有 ANN 索引,只能全量扫描;Float32 存 1024 维 × 5 万条 = 200MB,内存扛不住,
 * 量化到 int8 后是 50MB,可常驻内存。精度损失只影响粗排序,后面还有 rerank 兜底。
 */

/** 单条向量的量化结果。scale 随条存,反量化时用。 */
export interface Quantized {
  q: Int8Array;
  scale: number;
}

/** L2 归一化。零向量原样返回(调用方需自行判定无效)。 */
export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** 对称量化:scale = max|v| / 127,零向量 scale 记 0。入库前应先 l2Normalize。 */
export function quantize(v: Float32Array): Quantized {
  let peak = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]!);
    if (a > peak) peak = a;
  }
  const q = new Int8Array(v.length);
  if (peak === 0) return { q, scale: 0 };

  const scale = peak / 127;
  for (let i = 0; i < v.length; i++) {
    // round 而非 trunc:trunc 会引入系统性向零偏移
    const r = Math.round(v[i]! / scale);
    q[i] = r > 127 ? 127 : r < -127 ? -127 : r;
  }
  return { q, scale };
}

export function dequantize({ q, scale }: Quantized): Float32Array {
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i]! * scale;
  return out;
}

/**
 * 用 Float32 的查询向量扫过一整块 int8 矩阵,返回每条的余弦近似值。
 *
 * 查询侧不量化 —— 少一次量化误差,且成本相同。
 * 库内向量入库前已 L2 归一化,查询向量也需归一化后传入,此时点积即余弦。
 *
 * @param query  已归一化的查询向量,长度 = dim
 * @param matrix 连续存放的 count × dim 个 int8
 * @param scales 每条的量化 scale,长度 = count
 */
export function scanInt8Matrix(
  query: Float32Array,
  matrix: Int8Array,
  scales: Float32Array,
  dim: number,
  count: number,
): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const scale = scales[i]!;
    if (scale === 0) {
      out[i] = -1; // 零向量:不可比,排到最后
      continue;
    }
    const base = i * dim;
    let dot = 0;
    for (let d = 0; d < dim; d++) dot += query[d]! * matrix[base + d]!;
    out[i] = dot * scale;
  }
  return out;
}

/** 两条量化向量之间的余弦近似(调试台对照用)。 */
export function quantizedCosine(a: Quantized, b: Quantized): number {
  if (a.q.length !== b.q.length || a.scale === 0 || b.scale === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.q.length; i++) {
    const av = a.q[i]! * a.scale;
    const bv = b.q[i]! * b.scale;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? -1 : dot / denom;
}
