import { check, eq, ok, near, done } from './_assert.mjs';
import {
  l2Normalize,
  quantize,
  dequantize,
  scanInt8Matrix,
  quantizedCosine,
} from '../src/engine/quantize.ts';

console.log('quantize');

// 可复现的伪随机,免得 CI 上偶发失败
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomVec(dim, rand) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rand() * 2 - 1;
  return v;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

check('l2Normalize 产出单位向量', () => {
  const v = l2Normalize(new Float32Array([3, 4]));
  near(Math.hypot(v[0], v[1]), 1, 1e-6);
  near(v[0], 0.6, 1e-6);
});

check('l2Normalize 对零向量原样返回,不产出 NaN', () => {
  const z = l2Normalize(new Float32Array([0, 0, 0]));
  ok([...z].every(x => x === 0));
});

check('量化往返误差 < 1e-2', () => {
  const rand = rng(42);
  let worst = 0;
  for (let t = 0; t < 20; t++) {
    const v = l2Normalize(randomVec(256, rand));
    const back = dequantize(quantize(v));
    for (let i = 0; i < v.length; i++) worst = Math.max(worst, Math.abs(v[i] - back[i]));
  }
  ok(worst < 1e-2, `最大逐元素误差 ${worst}`);
});

check('零向量量化 scale 记 0', () => {
  const { q, scale } = quantize(new Float32Array(8));
  eq(scale, 0);
  ok([...q].every(x => x === 0));
});

check('量化余弦与 Float32 余弦逐对误差 < 1e-2', () => {
  const rand = rng(7);
  let worst = 0;
  for (let t = 0; t < 30; t++) {
    const a = l2Normalize(randomVec(256, rand));
    const b = l2Normalize(randomVec(256, rand));
    worst = Math.max(worst, Math.abs(quantizedCosine(quantize(a), quantize(b)) - cosine(a, b)));
  }
  ok(worst < 1e-2, `最大余弦误差 ${worst}`);
});

check('quantizedCosine 对维度不一致 / 零向量返回 -1', () => {
  eq(quantizedCosine(quantize(new Float32Array([1, 0])), quantize(new Float32Array([1, 0, 0]))), -1);
  eq(quantizedCosine(quantize(new Float32Array([1, 0])), quantize(new Float32Array([0, 0]))), -1);
});

check('scanInt8Matrix 的 topK 与 Float32 全精度 topK 高度重合', () => {
  const rand = rng(99);
  const dim = 128;
  const count = 400;

  const vectors = Array.from({ length: count }, () => l2Normalize(randomVec(dim, rand)));
  const matrix = new Int8Array(count * dim);
  const scales = new Float32Array(count);
  vectors.forEach((v, i) => {
    const { q, scale } = quantize(v);
    matrix.set(q, i * dim);
    scales[i] = scale;
  });

  const query = l2Normalize(randomVec(dim, rand));
  const approx = scanInt8Matrix(query, matrix, scales, dim, count);

  const topOf = scores =>
    [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, 20);
  const exact = vectors.map(v => cosine(query, v));

  const overlap = topOf(approx).filter(i => topOf(exact).includes(i)).length;
  ok(overlap >= 19, `top20 重合 ${overlap}/20`);
});

check('scanInt8Matrix 把零向量排到最后', () => {
  const dim = 4;
  const matrix = new Int8Array(2 * dim);
  const scales = new Float32Array([0, 1]);
  matrix.set(quantize(l2Normalize(new Float32Array([1, 0, 0, 0]))).q, dim);
  const scores = scanInt8Matrix(new Float32Array([1, 0, 0, 0]), matrix, scales, dim, 2);
  eq(scores[0], -1);
  ok(scores[1] > 0);
});

done('quantize');
