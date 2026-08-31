import { check, eq, ok, done } from './_assert.mjs';
import { buildQuery, formatHits, normalizeDepth, shouldRecallForType } from '../src/inject.ts';

console.log('inject');

await check('normalizeDepth 兜住用户编辑中的非法值', () => {
  eq(normalizeDepth(4), 4);
  eq(normalizeDepth('7'), 7);
  eq(normalizeDepth(3.9), 3);
  eq(normalizeDepth(-5), 0);
  eq(normalizeDepth(99999), 10000);
  eq(normalizeDepth(''), 4, '空串走 Number("")=0 之外的分支应回默认值');
  eq(normalizeDepth('abc'), 4);
  eq(normalizeDepth(undefined), 4);
  eq(normalizeDepth(NaN), 4);
});

await check('buildQuery 取最近 n 条,跳过系统消息与空消息', () => {
  const chat = [
    { mes: '第一条' },
    { mes: '系统提示', is_system: true },
    { mes: '   ' },
    { mes: '第二条' },
    { mes: '第三条' },
  ];
  eq(buildQuery(chat, 2), '第二条\n第三条');
  eq(buildQuery(chat, 10), '第一条\n第二条\n第三条');
});

await check('buildQuery 边界:空聊天、n 非正', () => {
  eq(buildQuery([], 3), '');
  eq(buildQuery([{ mes: 'a' }, { mes: 'b' }], 0), 'b', 'n<=0 至少取一条');
  eq(buildQuery([{ is_system: true, mes: 'x' }], 3), '');
});

await check('formatHits 无命中时产出空串(即清空注入槽)', () => {
  eq(formatHits([]), '');
});

await check('formatHits 用分隔符串起各条 document', () => {
  const text = formatHits([
    { kbId: 'k', kbName: 'K', ordinal: 0, title: '苏澄', document: '苏澄\n青梅竹马', score: 1 },
    { kbId: 'k', kbName: 'K', ordinal: 1, title: '东京', document: '东京\n故事发生地', score: 0.9 },
  ]);
  ok(text.includes('苏澄\n青梅竹马'));
  ok(text.includes('东京\n故事发生地'));
  ok(text.includes('---'), '两条之间应有分隔');
  ok(text.startsWith('# 知识库参考'), '应带说明性表头');
});

await check('shouldRecallForType 跳过不该重复召回的生成类型', () => {
  eq(shouldRecallForType(undefined), true);
  eq(shouldRecallForType('normal'), true);
  eq(shouldRecallForType('regenerate'), true);
  eq(shouldRecallForType('quiet'), false);
  eq(shouldRecallForType('impersonate'), false);
});

done('inject');
