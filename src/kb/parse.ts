/**
 * 文档 → 词条切分。
 *
 * md 按标题切、json 按数组元素切、txt 按空行或 `---` 切。
 * id 优先用标题 hash,保证在文件中间插入词条时后面各条 id 不位移 —— 这是增量重导只
 * embed 变动条目的前提。
 */

import type { KbChunk } from './types.ts';

/** FNV-1a 32 位,输出 8 位小写十六进制。用于 id 与内容指纹,不用于安全用途。 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // 乘 16777619,用移位组合避免 32 位溢出丢精度
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 切分产物:尚未定 id 的原始词条。 */
interface RawChunk {
  title: string;
  text: string;
}

export type KbFormat = 'md' | 'json' | 'txt';

/** 按扩展名判定格式;认不出的按 txt 处理。 */
export function detectFormat(fileName: string): KbFormat {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'json') return 'json';
  return 'txt';
}

/** md:任意层级 ATX 标题起一条;首个标题之前的内容若非空,单独作一条无标题词条。 */
function splitMarkdown(raw: string): RawChunk[] {
  const lines = raw.split(/\r?\n/);
  const chunks: RawChunk[] = [];
  let title = '';
  let buf: string[] = [];

  const flush = () => {
    const text = buf.join('\n').trim();
    if (title || text) chunks.push({ title, text });
    buf = [];
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      title = m[2]!.trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return chunks;
}

/**
 * json:支持三种形状
 *  - 字符串数组 → 每个元素一条,无标题
 *  - 对象数组   → 取 title/name/key 作标题,content/text/value/description 作正文
 *  - 对象字典   → 键作标题,值作正文
 */
function splitJson(raw: string): RawChunk[] {
  const data: unknown = JSON.parse(raw);

  const pick = (obj: Record<string, unknown>, keys: string[]): string => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  const fromValue = (v: unknown): string =>
    typeof v === 'string' ? v.trim() : JSON.stringify(v, null, 2);

  if (Array.isArray(data)) {
    return data.map(item => {
      if (typeof item === 'string') return { title: '', text: item.trim() };
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const title = pick(obj, ['title', 'name', 'key', 'comment']);
        const text = pick(obj, ['content', 'text', 'value', 'description', 'entry']);
        // 认不出约定字段时整条序列化,信息不丢
        return { title, text: text || fromValue(item) };
      }
      return { title: '', text: fromValue(item) };
    });
  }

  if (data && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>).map(([k, v]) => ({
      title: k,
      text: fromValue(v),
    }));
  }

  return [{ title: '', text: fromValue(data) }];
}

/**
 * txt:先按分隔行(三个及以上重复的 - = * 独占一行)切,没有分隔行则按空行切。
 * 段首若是方括号包裹的短行、或「短行 + 冒号结尾」,提为标题。
 */
function splitPlainText(raw: string): RawChunk[] {
  const bySeparator = raw.split(/^[ \t]*(?:-{3,}|={3,}|\*{3,})[ \t]*$/m);
  const blocks = (bySeparator.length > 1 ? bySeparator : raw.split(/\r?\n[ \t]*\r?\n/))
    .map(b => b.trim())
    .filter(Boolean);

  return blocks.map(block => {
    const lines = block.split(/\r?\n/);
    const head = (lines[0] ?? '').trim();
    const bracketed = /^[【\[](.+)[】\]]$/.exec(head);
    if (bracketed) {
      return { title: bracketed[1]!.trim(), text: lines.slice(1).join('\n').trim() };
    }
    if (lines.length > 1 && head.length <= 40 && /[:：]$/.test(head)) {
      return {
        title: head.replace(/[:：]$/, '').trim(),
        text: lines.slice(1).join('\n').trim(),
      };
    }
    return { title: '', text: block };
  });
}

/**
 * 解析并定 id。
 *
 * 标题在库内唯一才用标题 hash;重复标题一律退回序号 id —— 否则两条同名词条会互相覆盖。
 */
export function parseDocument(raw: string, fileName: string, kbId: string): KbChunk[] {
  const format = detectFormat(fileName);
  const rawChunks =
    format === 'md' ? splitMarkdown(raw) : format === 'json' ? splitJson(raw) : splitPlainText(raw);

  const kept = rawChunks.filter(c => c.title || c.text);

  const titleCounts = new Map<string, number>();
  for (const c of kept) {
    if (c.title) titleCounts.set(c.title, (titleCounts.get(c.title) ?? 0) + 1);
  }

  return kept.map((c, i) => {
    const document = c.title ? `${c.title}\n${c.text}` : c.text;
    const unique = c.title !== '' && titleCounts.get(c.title) === 1;
    return {
      id: unique ? `${kbId}:t${fnv1a(c.title)}` : `${kbId}:#${i}`,
      title: c.title,
      text: c.text,
      document,
      docHash: fnv1a(document),
    };
  });
}

/** 整库指纹:重复导入同一文件时用于提示「内容无变化」。 */
export function contentHashOf(chunks: KbChunk[]): string {
  return fnv1a(chunks.map(c => `${c.id} ${c.docHash}`).join(''));
}
