/**
 * 分词与归一化。BM25 的倒排表与查询必须走同一条路径,否则永远命中不了。
 *
 * 主路径 Intl.Segmenter('zh', word);运行环境没有它时回退 bigram。
 * 两条路径对纯 ASCII 输入产出完全一致 —— 回退实现只对 CJK 连续段做二元切分,
 * 拉丁/数字段一律整体成词,这是单测里断言的不变量。
 */

/** 分词口径版本。改了归一化规则、停用词或切分策略必须 +1,触发全库重建索引。 */
export const TOKENIZER_VERSION = 1;

/** CJK 统一表意文字 + 扩展 A + 兼容表意 + 假名(日文卡名也常见)。 */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/** 保留为词的字符:字母、数字、CJK。其余(标点、空白、符号)一律作分隔。 */
const WORDISH = /[\p{Letter}\p{Number}]/u;

const STOPWORDS = new Set([
  // 中文虚词:高频且几乎不携带检索信号
  '的', '了', '和', '是', '在', '也', '就', '都', '而', '及', '与', '着', '或',
  '一个', '不是', '这个', '那个', '什么', '没有', '可以', '这样', '那样',
  // 英文
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were',
  'it', 'this', 'that', 'for', 'on', 'at', 'as', 'be', 'by', 'with',
]);

/** NFKC 统一全半角,再降小写。索引与查询共用。 */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

let segmenter: Intl.Segmenter | null | undefined;

/** 缓存探测结果:Intl.Segmenter 不可用时为 null。 */
function getSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    segmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('zh', { granularity: 'word' })
        : null;
  } catch {
    segmenter = null;
  }
  return segmenter;
}

/** 把归一化后的文本切成「连续的成词字符」段,标点与空白在此丢弃。 */
function wordRuns(normalized: string): string[] {
  const runs: string[] = [];
  let buf = '';
  for (const ch of normalized) {
    if (WORDISH.test(ch)) {
      buf += ch;
    } else if (buf) {
      runs.push(buf);
      buf = '';
    }
  }
  if (buf) runs.push(buf);
  return runs;
}

/** 一段连续成词字符 → token。CJK 走二元,其余整体成词。 */
function bigramRun(run: string): string[] {
  const chars = [...run];
  if (!chars.some(c => CJK.test(c))) return [run];

  const out: string[] = [];
  let latin = '';
  const flushLatin = () => {
    if (latin) {
      out.push(latin);
      latin = '';
    }
  };

  // CJK 与拉丁可能在同一 run 里交替(如 "SSR级卡"),各按各的规则切
  let cjkBuf: string[] = [];
  const flushCjk = () => {
    if (!cjkBuf.length) return;
    if (cjkBuf.length === 1) {
      out.push(cjkBuf[0]!);
    } else {
      for (let i = 0; i + 1 < cjkBuf.length; i++) out.push(cjkBuf[i]! + cjkBuf[i + 1]!);
    }
    cjkBuf = [];
  };

  for (const ch of chars) {
    if (CJK.test(ch)) {
      flushLatin();
      cjkBuf.push(ch);
    } else {
      flushCjk();
      latin += ch;
    }
  }
  flushCjk();
  flushLatin();
  return out;
}

/** 回退路径:不依赖 Intl.Segmenter。 */
export function tokenizeBigram(text: string): string[] {
  const out: string[] = [];
  for (const run of wordRuns(normalizeText(text))) out.push(...bigramRun(run));
  return out.filter(t => !STOPWORDS.has(t));
}

/** 主路径:Intl.Segmenter 分词;不可用时自动回退。 */
export function tokenize(text: string): string[] {
  const seg = getSegmenter();
  if (!seg) return tokenizeBigram(text);

  const out: string[] = [];
  for (const run of wordRuns(normalizeText(text))) {
    // 已经剥掉标点,Segmenter 在纯成词串上只需按 isWordLike 过一遍
    for (const { segment, isWordLike } of seg.segment(run)) {
      if (isWordLike && segment) out.push(segment);
    }
  }
  return out.filter(t => !STOPWORDS.has(t));
}

/** term → 该 term 在文档内出现次数。 */
export function termFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}
