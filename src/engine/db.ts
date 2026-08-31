/**
 * IndexedDB:词条正文、量化向量、倒排表。
 *
 * 三个表:
 *  - `chunks`   keyPath [kbId, ordinal] —— 正文 + 量化向量。ordinal 是库内序号,倒排表引用它。
 *  - `postings` keyPath [kbId, term]    —— 每个 term 一行。查询只读 query 那几十个 term,
 *                                          不反序列化整个索引,这是每轮生成前能跑 BM25 的前提。
 *  - `kbmeta`   keyPath kbId            —— 库级统计量 + ordinal → chunkId 映射。
 *
 * 向量以 Int8Array 直存:IndexedDB 的结构化克隆原生支持类型化数组,免反复编解码。
 */

import type { PostingRow } from './bm25.ts';

const DB_NAME = 'srdb';
const DB_VERSION = 1;

export const STORE_CHUNKS = 'chunks';
export const STORE_POSTINGS = 'postings';
export const STORE_META = 'kbmeta';

/** 一条词条在库中的完整记录。 */
export interface ChunkRecord {
  kbId: string;
  /** 库内序号,倒排表与向量矩阵都按它索引。 */
  ordinal: number;
  chunkId: string;
  title: string;
  text: string;
  document: string;
  docHash: string;
  /** 文档 token 数,BM25 长度归一用。 */
  len: number;
  /** 量化向量;尚未 embed 时为 null。 */
  vec: Int8Array | null;
  scale: number;
}

export interface PostingRecord extends PostingRow {
  kbId: string;
}

/** 库级统计量。 */
export interface KbMetaRecord {
  kbId: string;
  /** 文档总数 */
  N: number;
  avgdl: number;
  /** 向量维度;尚未 embed 时为 0。 */
  dim: number;
  /** 建索引时用的 embedding 模型,换模型必须重建向量。 */
  embedModel: string;
  /** 分词口径版本,变更必须重建倒排表。 */
  tokenizerVersion: number;
  /** 按 ordinal 索引的 chunkId。 */
  ordinalToChunkId: string[];
  docLens: number[];
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        db.createObjectStore(STORE_CHUNKS, { keyPath: ['kbId', 'ordinal'] });
      }
      if (!db.objectStoreNames.contains(STORE_POSTINGS)) {
        db.createObjectStore(STORE_POSTINGS, { keyPath: ['kbId', 'term'] });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'kbId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqDone<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** `[kbId, *]` 的整段范围,用于按库取全部或按库清空。 */
function kbRange(kbId: string): IDBKeyRange {
  return IDBKeyRange.bound([kbId], [kbId, []]);
}

/* ---------- chunks ---------- */

export async function putChunks(records: ChunkRecord[]): Promise<void> {
  if (!records.length) return;
  const db = await openDb();
  const tx = db.transaction(STORE_CHUNKS, 'readwrite');
  const os = tx.objectStore(STORE_CHUNKS);
  for (const r of records) os.put(r);
  await txDone(tx);
}

export async function getAllChunks(kbId: string): Promise<ChunkRecord[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_CHUNKS, 'readonly');
  const rows = await reqDone(tx.objectStore(STORE_CHUNKS).getAll(kbRange(kbId)));
  return rows as ChunkRecord[];
}

/** 按序号取若干条正文(检索命中后回捞用)。 */
export async function getChunksByOrdinal(kbId: string, ordinals: number[]): Promise<ChunkRecord[]> {
  if (!ordinals.length) return [];
  const db = await openDb();
  const tx = db.transaction(STORE_CHUNKS, 'readonly');
  const os = tx.objectStore(STORE_CHUNKS);
  const rows = await Promise.all(
    ordinals.map(o => reqDone(os.get([kbId, o]) as IDBRequest<ChunkRecord | undefined>)),
  );
  await txDone(tx);
  return rows.filter((r): r is ChunkRecord => !!r);
}

/* ---------- postings ---------- */

export async function putPostings(kbId: string, rows: PostingRow[]): Promise<void> {
  if (!rows.length) return;
  const db = await openDb();
  const tx = db.transaction(STORE_POSTINGS, 'readwrite');
  const os = tx.objectStore(STORE_POSTINGS);
  for (const r of rows) os.put({ kbId, ...r } satisfies PostingRecord);
  await txDone(tx);
}

/** 只取 query 用到的 term —— 全库倒排表可能几十 MB,不能整取。 */
export async function getPostingRows(kbId: string, terms: string[]): Promise<PostingRow[]> {
  if (!terms.length) return [];
  const db = await openDb();
  const tx = db.transaction(STORE_POSTINGS, 'readonly');
  const os = tx.objectStore(STORE_POSTINGS);
  const unique = [...new Set(terms)];
  const rows = await Promise.all(
    unique.map(t => reqDone(os.get([kbId, t]) as IDBRequest<PostingRecord | undefined>)),
  );
  await txDone(tx);
  return rows.filter((r): r is PostingRecord => !!r);
}

/* ---------- meta ---------- */

export async function getMeta(kbId: string): Promise<KbMetaRecord | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readonly');
  const row = await reqDone(tx.objectStore(STORE_META).get(kbId) as IDBRequest<KbMetaRecord | undefined>);
  return row ?? null;
}

export async function putMeta(meta: KbMetaRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put(meta);
  await txDone(tx);
}

/* ---------- 清理 ---------- */

/** 删库:三个表按 kbId 整段清掉,并让向量矩阵缓存失效。 */
export async function deleteKb(kbId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_CHUNKS, STORE_POSTINGS, STORE_META], 'readwrite');
  tx.objectStore(STORE_CHUNKS).delete(kbRange(kbId));
  tx.objectStore(STORE_POSTINGS).delete(kbRange(kbId));
  tx.objectStore(STORE_META).delete(kbId);
  await txDone(tx);
  invalidateVectorMatrix(kbId);
}

/* ---------- 向量矩阵 ---------- */

/** 供全量扫描用的连续矩阵。ordinals[i] 是矩阵第 i 行对应的 chunk 序号。 */
export interface VectorMatrix {
  matrix: Int8Array;
  scales: Float32Array;
  ordinals: Int32Array;
  dim: number;
  count: number;
}

const matrixCache = new Map<string, VectorMatrix>();

export function invalidateVectorMatrix(kbId?: string): void {
  if (kbId === undefined) matrixCache.clear();
  else matrixCache.delete(kbId);
}

/**
 * 把整库量化向量拼成一块连续 Int8Array 并常驻内存。
 *
 * 1024 维 × 5 万条 ≈ 50MB,可接受;同规模 Float32 是 200MB,扛不住 —— 量化就是为这一步。
 * 尚未 embed(vec 为 null)的条目不进矩阵,由 ordinals 记录实际行号映射。
 */
export async function loadVectorMatrix(kbId: string): Promise<VectorMatrix | null> {
  const cached = matrixCache.get(kbId);
  if (cached) return cached;

  const chunks = (await getAllChunks(kbId)).filter(c => c.vec && c.vec.length > 0);
  if (!chunks.length) return null;

  const dim = chunks[0]!.vec!.length;
  // 维度不一致 = 中途换过 embedding 模型,这些行不可比,直接排除
  const usable = chunks.filter(c => c.vec!.length === dim);
  const count = usable.length;

  const matrix = new Int8Array(count * dim);
  const scales = new Float32Array(count);
  const ordinals = new Int32Array(count);

  usable.forEach((c, i) => {
    matrix.set(c.vec!, i * dim);
    scales[i] = c.scale;
    ordinals[i] = c.ordinal;
  });

  const built: VectorMatrix = { matrix, scales, ordinals, dim, count };
  matrixCache.set(kbId, built);
  return built;
}

/* ---------- 重建索引用的定点清理 ---------- */

/**
 * 删掉序号 >= from 的 chunk。
 * 重建时词条可能变少,新写入按 keyPath 覆盖前面的,尾部残留必须单独清掉。
 */
export async function deleteChunksFrom(kbId: string, from: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_CHUNKS, 'readwrite');
  tx.objectStore(STORE_CHUNKS).delete(IDBKeyRange.bound([kbId, from], [kbId, []]));
  await txDone(tx);
  invalidateVectorMatrix(kbId);
}

/** 清空某库的倒排表。序号每次重建都会重排,旧表整体作废,只能清后重写。 */
export async function clearPostings(kbId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_POSTINGS, 'readwrite');
  tx.objectStore(STORE_POSTINGS).delete(kbRange(kbId));
  await txDone(tx);
}
