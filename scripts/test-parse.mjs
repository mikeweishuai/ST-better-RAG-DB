import { check, eq, ok, done } from './_assert.mjs';
import { parseDocument, detectFormat, fnv1a, contentHashOf } from '../src/kb/parse.ts';

console.log('parse');

await check('detectFormat 按扩展名判定,认不出的按 txt', () => {
  eq(detectFormat('a.md'), 'md');
  eq(detectFormat('a.markdown'), 'md');
  eq(detectFormat('a.JSON'), 'json');
  eq(detectFormat('a.txt'), 'txt');
  eq(detectFormat('noext'), 'txt');
});

await check('fnv1a 稳定且为 8 位十六进制', () => {
  eq(fnv1a('hello'), fnv1a('hello'));
  ok(/^[0-9a-f]{8}$/.test(fnv1a('hello')));
  ok(fnv1a('a') !== fnv1a('b'));
});

await check('md 按标题切,document = 标题 + 换行 + 正文', () => {
  const md = '# 苏澄\n主角的青梅竹马。\n\n## 东京\n故事发生地。\n';
  const chunks = parseDocument(md, 'kb.md', 'k1');
  eq(chunks.length, 2);
  eq(chunks[0].title, '苏澄');
  eq(chunks[0].text, '主角的青梅竹马。');
  eq(chunks[0].document, '苏澄\n主角的青梅竹马。');
  eq(chunks[1].title, '东京');
});

await check('md 首个标题之前的正文单独成一条无标题词条', () => {
  const chunks = parseDocument('前言内容\n\n# 标题\n正文', 'kb.md', 'k1');
  eq(chunks.length, 2);
  eq(chunks[0].title, '');
  eq(chunks[0].text, '前言内容');
});

await check('txt 按分隔行切,方括号首行提为标题', () => {
  const txt = '【苏澄】\n主角的青梅竹马\n---\n【东京】\n故事发生地';
  const chunks = parseDocument(txt, 'kb.txt', 'k1');
  eq(chunks.length, 2);
  eq(chunks[0].title, '苏澄');
  eq(chunks[0].text, '主角的青梅竹马');
});

await check('txt 无分隔行时按空行切', () => {
  const chunks = parseDocument('第一段\n\n第二段\n\n第三段', 'kb.txt', 'k1');
  eq(chunks.length, 3);
  eq(chunks.map(c => c.text), ['第一段', '第二段', '第三段']);
});

await check('txt 短行加冒号提为标题', () => {
  const chunks = parseDocument('苏澄:\n主角的青梅竹马', 'kb.txt', 'k1');
  eq(chunks[0].title, '苏澄');
  eq(chunks[0].text, '主角的青梅竹马');
});

await check('json 三种形状:字符串数组 / 对象数组 / 对象字典', () => {
  eq(parseDocument('["甲","乙"]', 'k.json', 'k1').map(c => c.text), ['甲', '乙']);

  const objArr = parseDocument('[{"title":"苏澄","content":"青梅竹马"}]', 'k.json', 'k1');
  eq(objArr[0].title, '苏澄');
  eq(objArr[0].text, '青梅竹马');

  const dict = parseDocument('{"苏澄":"青梅竹马"}', 'k.json', 'k1');
  eq(dict[0].title, '苏澄');
  eq(dict[0].text, '青梅竹马');
});

await check('json 对象缺约定字段时整条序列化,信息不丢', () => {
  const chunks = parseDocument('[{"foo":"bar"}]', 'k.json', 'k1');
  ok(chunks[0].text.includes('foo'));
  ok(chunks[0].text.includes('bar'));
});

await check('唯一标题用标题 hash 作 id', () => {
  const chunks = parseDocument('# 苏澄\n甲\n\n# 东京\n乙', 'kb.md', 'k1');
  eq(chunks[0].id, `k1:t${fnv1a('苏澄')}`);
  eq(chunks[1].id, `k1:t${fnv1a('东京')}`);
});

await check('标题重复时退回序号 id,避免互相覆盖', () => {
  const chunks = parseDocument('# 同名\n甲\n\n# 同名\n乙', 'kb.md', 'k1');
  eq(chunks[0].id, 'k1:#0');
  eq(chunks[1].id, 'k1:#1');
  ok(chunks[0].id !== chunks[1].id);
});

// 增量重导的核心保证:只有真正变动的条目需要重新 embed
await check('文件中间插入新词条后,后面各条 id 不位移', () => {
  const before = parseDocument('# A\n甲\n\n# B\n乙\n\n# C\n丙', 'kb.md', 'k1');
  const after = parseDocument('# A\n甲\n\n# NEW\n新\n\n# B\n乙\n\n# C\n丙', 'kb.md', 'k1');

  const idOf = (chunks, title) => chunks.find(c => c.title === title).id;
  for (const t of ['A', 'B', 'C']) {
    eq(idOf(after, t), idOf(before, t), `词条 ${t} 的 id 必须保持不变`);
  }
  ok(after.some(c => c.title === 'NEW'));
});

await check('只有正文变动的条目 docHash 变,其余不变', () => {
  const before = parseDocument('# A\n甲\n\n# B\n乙', 'kb.md', 'k1');
  const after = parseDocument('# A\n甲\n\n# B\n乙改', 'kb.md', 'k1');
  const hashOf = (chunks, title) => chunks.find(c => c.title === title).docHash;
  eq(hashOf(after, 'A'), hashOf(before, 'A'));
  ok(hashOf(after, 'B') !== hashOf(before, 'B'));
});

await check('contentHashOf:内容不变则整库指纹不变', () => {
  const a = parseDocument('# A\n甲\n\n# B\n乙', 'kb.md', 'k1');
  const b = parseDocument('# A\n甲\n\n# B\n乙', 'kb.md', 'k1');
  const c = parseDocument('# A\n甲\n\n# B\n乙改', 'kb.md', 'k1');
  eq(contentHashOf(a), contentHashOf(b));
  ok(contentHashOf(a) !== contentHashOf(c));
});

await check('空文档与纯空白产出空数组', () => {
  eq(parseDocument('', 'kb.md', 'k1'), []);
  eq(parseDocument('   \n\n  \n', 'kb.txt', 'k1'), []);
});

done('parse');
