import { check, eq, ok, done } from './_assert.mjs';
import { normalizeText, tokenize, tokenizeBigram, termFrequencies } from '../src/engine/tokenize.ts';

console.log('tokenize');

check('NFKC 统一全半角,并降小写', () => {
  eq(normalizeText('ＳＳＲ级'), 'ssr级');
  eq(normalizeText('１２３'), '123');
});

check('标点与空白被剥离,不进 token', () => {
  eq(tokenize('hello, world!'), ['hello', 'world']);
  eq(tokenizeBigram('hello, world!'), ['hello', 'world']);
});

check('停用词被过滤', () => {
  ok(!tokenize('the cat is on the mat').includes('the'));
  ok(!tokenize('the cat is on the mat').includes('is'));
  ok(tokenize('the cat is on the mat').includes('cat'));
});

// 这是两条分词路径之间唯一被强保证的不变量:回退实现只对 CJK 段做二元切分,
// 拉丁/数字段一律整体成词,所以纯 ASCII 输入两条路径必须逐字节一致。
check('纯 ASCII 输入:Segmenter 路径与 bigram 回退路径完全一致', () => {
  for (const s of [
    'The Quick brown-fox, jumps!',
    'attack power 120 / defense 80',
    'v1.2.3 release notes',
    '',
  ]) {
    eq(tokenize(s), tokenizeBigram(s), `input=${JSON.stringify(s)}`);
  }
});

check('bigram 回退:CJK 段切二元,拉丁段整体保留', () => {
  eq(tokenizeBigram('攻击力'), ['攻击', '击力']);
  eq(tokenizeBigram('ssr卡牌'), ['ssr', '卡牌']);
  // 单字 CJK 段无法成二元,退化为单字
  eq(tokenizeBigram('猫 dog'), ['猫', 'dog']);
});

check('空输入与纯标点产出空数组', () => {
  eq(tokenize(''), []);
  eq(tokenize('   \n\t  '), []);
  eq(tokenize('!@#$%^&*()'), []);
  eq(tokenizeBigram('!@#$%^&*()'), []);
});

check('两条路径都不产出空字符串 token', () => {
  const s = '苏澄, the SSR-level 卡牌!! 攻击力 120。';
  ok(tokenize(s).every(t => t.length > 0));
  ok(tokenizeBigram(s).every(t => t.length > 0));
});

check('termFrequencies 统计词频', () => {
  eq([...termFrequencies(['a', 'b', 'a', 'a'])], [['a', 3], ['b', 1]]);
  eq([...termFrequencies([])], []);
});

done('tokenize');
