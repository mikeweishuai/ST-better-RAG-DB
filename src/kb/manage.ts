/**
 * 知识库的增删改:导入、重导、删除、启停。
 *
 * 元数据落 extension_settings(跨设备同步),正文与索引落 IndexedDB。
 * 两边的唯一纽带是 kbId。
 */

import { buildKbIndex, type BuildProgress, type BuildReport } from '../engine/build.ts';
import { deleteKb } from '../engine/db.ts';
import { settings, updateSettings } from '../settings.ts';
import { contentHashOf, parseDocument, fnv1a } from './parse.ts';
import type { KbEntry } from './types.ts';

export interface ImportOptions {
  /** 导入到已有库(重导);不传则新建 */
  kbId?: string;
  signal?: AbortSignal;
  onProgress?: (p: BuildProgress) => void;
}

export type ImportOutcome =
  | { status: 'unchanged'; entry: KbEntry }
  | { status: 'built'; entry: KbEntry; report: BuildReport };

/** kbId 基于文件名 + 时间戳,保证同名文件多次导入不撞库。 */
function newKbId(fileName: string): string {
  return `${fnv1a(fileName)}${Date.now().toString(36)}`;
}

function findEntry(kbId: string): KbEntry | undefined {
  return settings.value.kbs.find(k => k.id === kbId);
}

/**
 * 导入或重导一份文档。
 *
 * 重导时若内容指纹未变,直接返回 unchanged,不碰索引也不发任何 embedding 请求。
 */
export async function importKbFromText(
  raw: string,
  fileName: string,
  opts: ImportOptions = {},
): Promise<ImportOutcome> {
  const kbId = opts.kbId ?? newKbId(fileName);
  const existing = opts.kbId ? findEntry(kbId) : undefined;

  const chunks = parseDocument(raw, fileName, kbId);
  if (!chunks.length) throw new Error('未能从该文件解析出任何词条');

  const contentHash = contentHashOf(chunks);
  if (existing && existing.contentHash === contentHash) {
    return { status: 'unchanged', entry: existing };
  }

  const report = await buildKbIndex({
    kbId,
    chunks,
    embedCfg: settings.value.embedding,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });

  const entry: KbEntry = {
    id: kbId,
    name: existing?.name ?? fileName.replace(/\.[^.]+$/, ''),
    sourceName: fileName,
    chunkCount: chunks.length,
    contentHash,
    enabled: existing?.enabled ?? true,
    updatedAt: Date.now(),
  };

  updateSettings(draft => {
    const at = draft.kbs.findIndex(k => k.id === kbId);
    if (at >= 0) draft.kbs[at] = entry;
    else draft.kbs.push(entry);
  });

  return { status: 'built', entry, report };
}

/** 从 File 读文本再走同一条导入路径。 */
export async function importKbFromFile(file: File, opts: ImportOptions = {}): Promise<ImportOutcome> {
  return importKbFromText(await file.text(), file.name, opts);
}

/** 删库:索引与元数据一起清,顺序上先清索引 —— 元数据没了但索引还在会成为孤儿数据。 */
export async function removeKb(kbId: string): Promise<void> {
  await deleteKb(kbId);
  updateSettings(draft => {
    draft.kbs = draft.kbs.filter(k => k.id !== kbId);
  });
}

/** 单库开关:关掉只是不参与召回,索引仍在,随时可开回。 */
export function setKbEnabled(kbId: string, enabled: boolean): void {
  updateSettings(draft => {
    const entry = draft.kbs.find(k => k.id === kbId);
    if (entry) entry.enabled = enabled;
  });
}

export function renameKb(kbId: string, name: string): void {
  updateSettings(draft => {
    const entry = draft.kbs.find(k => k.id === kbId);
    if (entry) entry.name = name.trim() || entry.name;
  });
}

/** 参与召回的库。 */
export function activeKbs(): KbEntry[] {
  return settings.value.kbs.filter(k => k.enabled);
}
