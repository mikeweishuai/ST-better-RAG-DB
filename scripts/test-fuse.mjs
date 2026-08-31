import { check, eq, ok, near, done } from './_assert.mjs';
import { rrf, weightedNormalized, DEFAULT_RRF_K } from '../src/retrieve/fuse.ts';

console.log('fuse');

const bm25 = { name: 'bm25', hits: [{ o: 1, score: 9 }, { o: 2, score: 5 }, { o: 3, score: 1 }] };
const vector = { name: 'vector', hits: [{ o: 3, score: 0.9 }, { o: 1, score: 0.8 }, { o: 4, score: 0.7 }] };

check('RRF 分数手算', () => {
  const k = DEFAULT_RRF_K;
  const fused = rrf([bm25, vector], 10);
  const byId = Object.fromEntries(fused.map(h => [h.o, h.score]));
  // o=1:bm25 第 1 名 + vector 第 2 名
  near(byId[1], 1 / (k + 1) + 1 / (k + 2), 1e-12);
  // o=4:只在 vector 第 3 名
  near(byId[4], 1 / (k + 3), 1e-12);
});

check('两路都命中的条目排在只单路命中的前面', () => {
  const fused = rrf([bm25, vector], 10);
  eq(fused.map(h => h.o), [1, 3, 2, 4]);
});

check('ranks 记录每路名次,可据此标「只有某路命中」', () => {
  const fused = rrf([bm25, vector], 10);
  const byId = Object.fromEntries(fused.map(h => [h.o, h.ranks]));
  eq(byId[1], { bm25: 1, vector: 2 });
  eq(byId[2], { bm25: 2 });
  eq(byId[4], { vector: 3 });
  ok(!('bm25' in byId[4]), 'o=4 未被 bm25 命中');
});

check('单路为空时退化为另一路的原序', () => {
  const fused = rrf([{ name: 'bm25', hits: [] }, vector], 10);
  eq(fused.map(h => h.o), [3, 1, 4]);
});

check('全部为空产出空数组', () => {
  eq(rrf([], 10), []);
  eq(rrf([{ name: 'a', hits: [] }], 10), []);
});

check('topN 截断', () => {
  eq(rrf([bm25, vector], 2).length, 2);
});

check('k 越大,名次差异被压得越平', () => {
  const tight = rrf([bm25], 10, 1);
  const flat = rrf([bm25], 10, 10000);
  const spreadTight = tight[0].score - tight[2].score;
  const spreadFlat = flat[0].score - flat[2].score;
  ok(spreadTight > spreadFlat, `${spreadTight} 应大于 ${spreadFlat}`);
});

check('加权归一化:权重生效', () => {
  const heavyBm25 = weightedNormalized([bm25, vector], { bm25: 10, vector: 1 }, 10);
  eq(heavyBm25[0].o, 1, 'bm25 首位应被推到最前');
});

check('加权归一化:单路内全部同分时该路整体记 1,不产出 NaN', () => {
  const flat = { name: 'flat', hits: [{ o: 1, score: 5 }, { o: 2, score: 5 }] };
  const fused = weightedNormalized([flat], { flat: 1 }, 10);
  ok(fused.every(h => Number.isFinite(h.score)));
  eq(fused.map(h => h.score), [1, 1]);
});

done('fuse');
