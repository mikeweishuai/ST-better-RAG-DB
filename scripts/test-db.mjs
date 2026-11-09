import 'fake-indexeddb/auto';
import { check, eq, ok, done } from './_assert.mjs';
import {
  getAllChunks,
  getMeta,
  getPostingRows,
  loadVectorMatrix,
  openDb,
  replaceKbIndex,
  STORE_CHUNKS,
  STORE_META,
  STORE_POSTINGS,
} from '../src/engine/db.ts';

console.log('db');

// 测试进程使用独立的内存 IndexedDB,额外唯一索引用于制造真实的异步请求失败。
await new Promise((resolve, reject) => {
  const request = indexedDB.open('srdb', 1);
  request.onupgradeneeded = () => {
    const chunks = request.result.createObjectStore(STORE_CHUNKS, { keyPath: ['kbId', 'ordinal'] });
    chunks.createIndex('test-unique-chunk', ['kbId', 'chunkId'], { unique: true });
    request.result.createObjectStore(STORE_POSTINGS, { keyPath: ['kbId', 'term'] });
    request.result.createObjectStore(STORE_META, { keyPath: 'kbId' });
  };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    request.result.close();
    resolve();
  };
});

function fixture(kbId, names) {
  const records = names.map((name, ordinal) => ({
    kbId,
    ordinal,
    chunkId: `${kbId}:${name}`,
    title: name,
    text: `正文 ${name}`,
    document: `${name}\n正文 ${name}`,
    docHash: name,
    len: 2,
    vec: new Int8Array([ordinal + 1, 2]),
    scale: 0.01,
  }));
  const rows = names.map((name, ordinal) => ({
    term: name,
    df: 1,
    entries: [{ o: ordinal, tf: 1 }],
  }));
  const meta = {
    kbId,
    N: records.length,
    avgdl: 2,
    dim: 2,
    embedModel: 'test-model',
    tokenizerVersion: 1,
    ordinalToChunkId: records.map(r => r.chunkId),
    docLens: records.map(r => r.len),
    updatedAt: 123,
  };
  return { records, rows, meta };
}

function replace(kbId, value) {
  return replaceKbIndex(kbId, value.records, value.rows, value.meta);
}

async function snapshot(kbId, terms) {
  const [records, rows, meta] = await Promise.all([
    getAllChunks(kbId),
    getPostingRows(kbId, terms),
    getMeta(kbId),
  ]);
  return { records, rows, meta };
}

await check('首次建库同时提交正文、倒排与统计量,并保留类型化向量', async () => {
  const value = fixture('first', ['苏澄', '东京']);
  await replace('first', value);
  const stored = await snapshot('first', ['苏澄', '东京']);
  eq(stored.records, value.records);
  ok(stored.records[0].vec instanceof Int8Array, '向量应保留 Int8Array 类型');
  eq(stored.rows, value.rows.map(row => ({ ...row, kbId: 'first' })));
  eq(stored.meta, value.meta);
});

await check('重建删掉旧正文尾部与全部旧倒排,仅保留新版本统计量', async () => {
  await replace('rebuild', fixture('rebuild', ['旧甲', '旧乙', '旧丙']));
  const next = fixture('rebuild', ['新甲']);
  await replace('rebuild', next);
  const stored = await snapshot('rebuild', ['旧甲', '旧乙', '旧丙', '新甲']);
  eq(stored.records, next.records);
  eq(stored.rows, next.rows.map(row => ({ ...row, kbId: 'rebuild' })));
  eq(stored.meta, next.meta);
});

await check('重建只影响指定知识库,其他库数据与矩阵缓存保持有效', async () => {
  await replace('isolated', fixture('isolated', ['隔离甲']));
  await replace('target', fixture('target', ['修改前']));
  const before = await snapshot('isolated', ['隔离甲']);
  const matrix = await loadVectorMatrix('isolated');
  await replace('target', fixture('target', ['修改后']));
  eq(await snapshot('isolated', ['隔离甲']), before);
  ok((await loadVectorMatrix('isolated')) === matrix, '不应误清其他库缓存');
});

await check('同步 DataCloneError 会回滚已排队的删除,保留旧索引与缓存', async () => {
  await replace('clone-fail', fixture('clone-fail', ['旧设定']));
  const before = await snapshot('clone-fail', ['旧设定', '新设定']);
  const matrix = await loadVectorMatrix('clone-fail');
  const next = fixture('clone-fail', ['新设定']);
  next.rows[0].uncloneable = () => {};
  let error;
  try {
    await replace('clone-fail', next);
  } catch (e) {
    error = e;
  }
  eq(error?.name, 'DataCloneError');
  eq(await snapshot('clone-fail', ['旧设定', '新设定']), before);
  ok((await loadVectorMatrix('clone-fail')) === matrix, '失败不应清空有效缓存');
});

await check('异步请求失败时三表整体回滚,不会留下新正文或空倒排', async () => {
  await replace('async-fail', fixture('async-fail', ['旧甲', '旧乙']));
  const before = await snapshot('async-fail', ['旧甲', '旧乙', '新甲', '新乙']);
  const matrix = await loadVectorMatrix('async-fail');
  const next = fixture('async-fail', ['新甲', '新乙']);
  // 唯一索引冲突发生在请求执行阶段,区别于 put 当场抛出的克隆异常。
  next.records[1].chunkId = next.records[0].chunkId;
  let error;
  try {
    await replace('async-fail', next);
  } catch (e) {
    error = e;
  }
  eq(error?.name, 'ConstraintError');
  eq(await snapshot('async-fail', ['旧甲', '旧乙', '新甲', '新乙']), before);
  ok((await loadVectorMatrix('async-fail')) === matrix);
});

await check('成功提交后向量缓存失效,再次扫描得到新版本', async () => {
  const previous = fixture('cache', ['原向量']);
  await replace('cache', previous);
  const oldMatrix = await loadVectorMatrix('cache');
  const next = fixture('cache', ['新向量甲', '新向量乙']);
  next.records[0].vec = new Int8Array([100, 101]);
  await replace('cache', next);
  const newMatrix = await loadVectorMatrix('cache');
  ok(newMatrix !== oldMatrix);
  eq(newMatrix.count, 2);
  eq(Array.from(newMatrix.matrix), [100, 101, 2, 2]);
});

await check('混入其他库 ID 的记录在写入前被拒绝,不污染任何库', async () => {
  await replace('validate', fixture('validate', ['有效设定']));
  const before = await snapshot('validate', ['有效设定', '无效设定']);
  const next = fixture('validate', ['无效设定']);
  next.records[0].kbId = 'wrong-kb';
  let failed = false;
  try {
    await replace('validate', next);
  } catch {
    failed = true;
  }
  ok(failed);
  eq(await snapshot('validate', ['有效设定', '无效设定']), before);
  eq(await getAllChunks('wrong-kb'), []);
});

(await openDb()).close();
done('db');
