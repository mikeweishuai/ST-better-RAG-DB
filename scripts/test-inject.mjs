import { check, eq, ok, done } from './_assert.mjs';
import { register } from 'node:module';

// 只替换检索边界,使测试能控制异步完成顺序,不依赖浏览器 IndexedDB 或真实端点。
const pipelineUrl = new URL('../src/retrieve/pipeline.ts', import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url === ${JSON.stringify(pipelineUrl)}) return {
      format: 'module', shortCircuit: true,
      source: 'export const retrieve = (...args) => globalThis.__srdbTestRetrieve(...args);',
    };
    return nextLoad(url, context);
  }
`)}`, import.meta.url);

const {
  buildQuery, clearInjection, formatHits, normalizeDepth, runRecall, shouldRecallForType,
} = await import('../src/inject.ts');
const { defaultSettings, settings } = await import('../src/settings.ts');
const { lastDebug, lastInjected } = await import('../src/state/runtime.ts');

function outcome(query, document = query) {
  return {
    hits: [{ kbId: 'kb', kbName: 'K', ordinal: 0, title: query, document, score: 1 }],
    debug: { query, terms: [], stages: {}, timings: {}, notes: [], degraded: {} },
  };
}

async function withRecallHost(fn) {
  const previousHost = globalThis.SillyTavern;
  const previousRetrieve = globalThis.__srdbTestRetrieve;
  const previousSettings = settings.value;
  const writes = [];
  const chat = [{ mes: '宿主中的旧回答' }];
  globalThis.SillyTavern = {
    getContext: () => ({ chat, setExtensionPrompt: (...args) => writes.push(args) }),
  };
  settings.value = {
    ...defaultSettings(),
    kbs: [{ id: 'kb', name: 'K', enabled: true }],
  };
  try {
    await fn({ writes, chat });
  } finally {
    clearInjection();
    settings.value = previousSettings;
    globalThis.SillyTavern = previousHost;
    globalThis.__srdbTestRetrieve = previousRetrieve;
  }
}

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

await check('runRecall 使用本轮提示词聊天,不把 swipe 舍弃的旧回答放进查询', async () => {
  await withRecallHost(async ({ writes }) => {
    const queries = [];
    globalThis.__srdbTestRetrieve = async query => {
      queries.push(query);
      return outcome(query);
    };
    await runRecall(undefined, [{ mes: '本轮用户消息' }]);
    eq(queries, ['本轮用户消息']);
    ok(writes.at(-1)[1].includes('本轮用户消息'));

    await runRecall();
    eq(queries.at(-1), '宿主中的旧回答', '无显式 chat 时兼容默认调用');
  });
});

await check('切聊天或停止清空注入时,取消请求并拒绝迟到的旧结果', async () => {
  await withRecallHost(async ({ writes }) => {
    let finish;
    let recallSignal;
    globalThis.__srdbTestRetrieve = (_query, deps) => {
      recallSignal = deps.signal;
      return new Promise(resolve => { finish = resolve; });
    };
    const pending = runRecall();
    clearInjection();
    ok(recallSignal.aborted, '清空必须同时取消在途端点请求');
    const clearedWriteCount = writes.length;
    finish(outcome('旧聊天结果'));
    await pending;
    eq(writes.length, clearedWriteCount, '不响应取消的异步任务完成后也不得回写');
    eq(lastInjected.value, '');
    eq(lastDebug.value, null);
  });
});

await check('较旧召回晚于新召回完成时,不能覆盖新结果或清空新注入', async () => {
  for (const failOld of [false, true]) {
    await withRecallHost(async ({ writes }) => {
      let finishOld;
      globalThis.__srdbTestRetrieve = query => query === '旧轮次'
        ? new Promise((resolve, reject) => { finishOld = failOld ? reject : resolve; })
        : Promise.resolve(outcome(query));
      const old = runRecall(undefined, [{ mes: '旧轮次' }]);
      await runRecall(undefined, [{ mes: '新轮次' }]);
      const newWriteCount = writes.length;
      finishOld(failOld ? new Error('旧请求失败') : outcome('旧轮次'));
      await old;
      eq(writes.length, newWriteCount);
      ok(lastInjected.value.includes('新轮次'));
      eq(lastDebug.value.query, '新轮次');
    });
  }
});

await check('外部取消后不注入,已取消的 signal 不再发起检索', async () => {
  await withRecallHost(async () => {
    const controller = new AbortController();
    let finish;
    let calls = 0;
    let recallSignal;
    globalThis.__srdbTestRetrieve = (_query, deps) => {
      calls++;
      recallSignal = deps.signal;
      return new Promise(resolve => { finish = resolve; });
    };
    const pending = runRecall(controller.signal);
    controller.abort();
    ok(recallSignal.aborted);
    finish(outcome('已取消的结果'));
    await pending;
    eq(lastInjected.value, '');
    await runRecall(controller.signal);
    eq(calls, 1);
  });
});

done('inject');
