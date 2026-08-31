import { check, eq, ok, near, done } from './_assert.mjs';
import { bm25Score, buildPostings, idf, DEFAULT_BM25_PARAMS } from '../src/engine/bm25.ts';

console.log('bm25');

await check('IDF 恒正:df 取到 N 也不转负', () => {
  // Robertson 原式在 df > N/2 时为负,Lucene 的 ln(1+…) 变体不会
  ok(idf(10, 10) > 0);
  ok(idf(10, 9) > 0);
  ok(idf(10, 1) > idf(10, 5), '稀有词的 IDF 应更高');
});

await check('IDF 手算值', () => {
  // ln(1 + (10 - 2 + 0.5) / (2 + 0.5)) = ln(1 + 3.4) = ln(4.4)
  near(idf(10, 2), Math.log(4.4), 1e-12);
});

await check('单 term 打分手算比对', () => {
  const rows = [{ term: 'x', df: 1, entries: [{ o: 0, tf: 2 }] }];
  const stats = { N: 4, avgdl: 10, docLens: [10, 10, 10, 10] };
  const { k1, b } = DEFAULT_BM25_PARAMS;

  // dl === avgdl 时长度归一因子为 1
  const expected = (idf(4, 1) * (2 * (k1 + 1))) / (2 + k1 * 1);
  const got = bm25Score(rows, stats, 10);
  eq(got.length, 1);
  near(got[0].score, expected, 1e-12);
});

await check('短文档得分高于长文档(长度归一生效)', () => {
  const rows = [{ term: 'x', df: 2, entries: [{ o: 0, tf: 1 }, { o: 1, tf: 1 }] }];
  const stats = { N: 2, avgdl: 30, docLens: [10, 50] };
  const [first, second] = bm25Score(rows, stats, 10);
  eq(first.o, 0, '短文档应排在前');
  ok(first.score > second.score);
});

await check('多 term 得分累加', () => {
  const stats = { N: 3, avgdl: 5, docLens: [5, 5, 5] };
  const rowsA = [{ term: 'a', df: 1, entries: [{ o: 0, tf: 1 }] }];
  const rowsB = [{ term: 'b', df: 1, entries: [{ o: 0, tf: 1 }] }];
  const solo = bm25Score(rowsA, stats, 10)[0].score;
  const both = bm25Score([...rowsA, ...rowsB], stats, 10)[0].score;
  near(both, solo * 2, 1e-12);
});

await check('边界:空倒排行、N=0、avgdl=0 均不抛且不产出 NaN', () => {
  eq(bm25Score([], { N: 5, avgdl: 5, docLens: [5] }, 10), []);
  eq(bm25Score([{ term: 'x', df: 1, entries: [{ o: 0, tf: 1 }] }], { N: 0, avgdl: 0, docLens: [] }, 10), []);

  // avgdl=0 时退化为不做长度归一,而非 0 除产出 NaN
  const r = bm25Score(
    [{ term: 'x', df: 1, entries: [{ o: 0, tf: 1 }] }],
    { N: 1, avgdl: 0, docLens: [0] },
    10,
  );
  ok(Number.isFinite(r[0].score), `score=${r[0].score}`);
});

await check('df=0 的行被跳过(不产出 Infinity)', () => {
  const r = bm25Score(
    [{ term: 'x', df: 0, entries: [{ o: 0, tf: 1 }] }],
    { N: 3, avgdl: 5, docLens: [5, 5, 5] },
    10,
  );
  eq(r, []);
});

await check('docLens 缺项回落 avgdl,不产出 NaN', () => {
  const r = bm25Score(
    [{ term: 'x', df: 1, entries: [{ o: 7, tf: 1 }] }],
    { N: 3, avgdl: 5, docLens: [5] },
    10,
  );
  ok(Number.isFinite(r[0].score));
});

await check('topN 截断,且同分时按序号稳定排序', () => {
  const entries = [0, 1, 2, 3, 4].map(o => ({ o, tf: 1 }));
  const r = bm25Score(
    [{ term: 'x', df: 5, entries }],
    { N: 5, avgdl: 5, docLens: [5, 5, 5, 5, 5] },
    3,
  );
  eq(r.map(h => h.o), [0, 1, 2]);
});

await check('buildPostings:df / avgdl / 倒排结构', () => {
  const { rows, docLens, avgdl } = buildPostings(['cat dog', 'cat cat bird', '']);
  const cat = rows.find(r => r.term === 'cat');
  eq(cat.df, 2, 'cat 出现在两篇文档');
  eq(cat.entries, [{ o: 0, tf: 1 }, { o: 1, tf: 2 }]);
  eq(rows.find(r => r.term === 'bird').df, 1);
  eq(docLens, [2, 3, 0]);
  near(avgdl, 5 / 3, 1e-12);
});

await check('buildPostings 空输入', () => {
  const { rows, docLens, avgdl } = buildPostings([]);
  eq(rows, []);
  eq(docLens, []);
  eq(avgdl, 0);
});

await check('端到端:建索引后查询能命中正确文档', () => {
  const docs = ['苏澄 是 主角', '东京 是 城市', '主角 的 攻击力 很高'];
  const { rows, docLens, avgdl } = buildPostings(docs);
  const query = rows.filter(r => r.term === '攻击力');
  const hits = bm25Score(query, { N: docs.length, avgdl, docLens }, 5);
  eq(hits[0].o, 2);
});

done('bm25');
