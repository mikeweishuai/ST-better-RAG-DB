import { mock } from 'node:test';
import 'fake-indexeddb/auto';
import { check, eq, ok, done } from './_assert.mjs';
import { buildPostings } from '../src/engine/bm25.ts';
import { quantize } from '../src/engine/quantize.ts';
import { TOKENIZER_VERSION } from '../src/engine/tokenize.ts';
import { clearPostings, deleteKb, getAllChunks, getMeta, getPostingRows, putMeta } from '../src/engine/db.ts';

console.log('index');

// IndexedDB 运行真实事务实现,仅替换 Node 中不存在的浏览器 Worker 边界。
let embedCalls = 0;

mock.module(new URL('../src/engine/workerClient.ts', import.meta.url).href, {
  namedExports: {
    buildPostingsInWorker: async documents => buildPostings(documents),
    quantizeInWorker: async (flat, dim) => {
      const matrix = new Int8Array(flat.length);
      const scales = new Float32Array(flat.length / dim);
      for (let i = 0; i < scales.length; i++) {
        const result = quantize(flat.subarray(i * dim, (i + 1) * dim));
        matrix.set(result.q, i * dim);
        scales[i] = result.scale;
      }
      return { matrix, scales };
    },
  },
});

const { settings, defaultSettings } = await import('../src/settings.ts');
const { importKbFromText } = await import('../src/kb/manage.ts');
const { retrieve } = await import('../src/retrieve/pipeline.ts');
const { runRecall, clearInjection } = await import('../src/inject.ts');
const { lastDebug, lastInjected } = await import('../src/state/runtime.ts');
const raw = '# apples\nRed apples grow on trees.\n\n# engines\nDiesel engines need fuel.';
const configured = model => ({ baseUrl: 'https://example.invalid', apiKey: '', model, timeoutSec: 1, retries: 0 });

globalThis.fetch = async (_url, init) => {
  embedCalls++;
  const body = JSON.parse(init.body);
  return {
    ok: true,
    json: async () => ({
      data: body.input.map((text, index) => ({
        index,
        embedding: body.model === 'model-b' ? [0, 1, 0] : text.includes('apples') ? [1, 0, 0] : [0, 0, 1],
      })),
    }),
  };
};

async function reset() {
  for (const kb of settings.value.kbs) await deleteKb(kb.id);
  settings.value = defaultSettings();
  embedCalls = 0;
}

async function initial(model = '') {
  await reset();
  if (model) settings.value.embedding = configured(model);
  return importKbFromText(raw, 'sample.md');
}

const reimport = entry => importKbFromText(raw, 'sample.md', { kbId: entry.id });

await check('内容和索引配置均未变时不重建也不重复向量化', async () => {
  const { entry } = await initial('model-a');
  const before = await getMeta(entry.id);
  embedCalls = 0;
  eq((await reimport(entry)).status, 'unchanged');
  eq(embedCalls, 0);
  eq(await getMeta(entry.id), before);
});

await check('BM25-only 库补配 embedding 后同文重导可补建向量', async () => {
  const { entry } = await initial();
  eq((await getAllChunks(entry.id)).every(c => c.vec === null), true);
  settings.value.embedding = configured('model-a');
  const result = await reimport(entry);
  eq(result.status, 'built');
  eq(result.report.embedded, 2);
  eq(result.report.reused, 0);
  eq((await getMeta(entry.id)).embedModel, 'model-a');
  ok((await getAllChunks(entry.id)).every(c => c.vec?.length === 3));
});

await check('换成同维度的新模型后同文重导不复用旧向量', async () => {
  const { entry } = await initial('model-a');
  settings.value.embedding = configured('model-b');
  const result = await reimport(entry);
  eq(result.status, 'built');
  eq(result.report.embedded, 2);
  eq(result.report.reused, 0);
  eq((await getMeta(entry.id)).embedModel, 'model-b');
  ok((await getAllChunks(entry.id)).every(c => c.vec[1] === 127 && c.vec[0] === 0));
});

await check('只有同步元数据而本地索引缺失时同文重导可恢复', async () => {
  const { entry } = await initial('model-a');
  await deleteKb(entry.id);
  const result = await reimport(entry);
  eq(result.status, 'built');
  eq(result.report.embedded, 2);
  eq((await getAllChunks(entry.id)).length, 2);
  ok((await getPostingRows(entry.id, ['apples'])).length > 0);
});

await check('分词版本变化时同文重导重建倒排并复用未变向量', async () => {
  const { entry } = await initial('model-a');
  await putMeta({ ...await getMeta(entry.id), tokenizerVersion: TOKENIZER_VERSION - 1 });
  await clearPostings(entry.id);
  embedCalls = 0;
  const result = await reimport(entry);
  eq(result.status, 'built');
  eq(result.report.reused, 2);
  eq(embedCalls, 0);
  eq((await getMeta(entry.id)).tokenizerVersion, TOKENIZER_VERSION);
  ok((await getPostingRows(entry.id, ['apples'])).length > 0);
});

await check('关闭 embedding 重导新内容后再启用原模型可补齐全部向量', async () => {
  const { entry } = await initial('model-a');
  const changed = raw + '\n\n# pears\nGreen pears are sweet.';
  settings.value.embedding = defaultSettings().embedding;
  const bm25 = await importKbFromText(changed, 'sample.md', { kbId: entry.id });
  eq(bm25.status, 'built');
  eq(bm25.report.bm25Only, true);
  eq((await getAllChunks(entry.id)).length, 3);

  settings.value.embedding = configured('model-a');
  const restored = await importKbFromText(changed, 'sample.md', { kbId: entry.id });
  eq(restored.status, 'built');
  eq((await getMeta(entry.id)).embedModel, 'model-a');
  const records = await getAllChunks(entry.id);
  eq(records.length, 3);
  ok(records.every(c => c.vec?.length === 3));
});

await check('旧元数据虽记录相同模型但维度为零时仍可重建向量', async () => {
  const { entry } = await initial();
  await putMeta({ ...await getMeta(entry.id), embedModel: 'model-a', dim: 0 });
  settings.value.embedding = configured('model-a');
  const result = await reimport(entry);
  eq(result.status, 'built');
  eq(result.report.embedded, 2);
  eq((await getMeta(entry.id)).dim, 3);
  ok((await getAllChunks(entry.id)).every(c => c.vec?.length === 3));
});

function retrievalDeps(entry, model) {
  const s = settings.value;
  return {
    params: { ...s.retrieval, charBudget: s.injection.charBudget },
    embedCfg: configured(model),
    rerankCfg: s.rerank,
    kbs: [{ id: entry.id, name: entry.name }],
    debug: true,
  };
}

await check('换模型未重导时跳过同维旧向量,BM25 仍可召回并显示原因', async () => {
  const { entry } = await initial('model-a');
  const result = await retrieve('apples', retrievalDeps(entry, 'model-b'));
  eq(result.debug.stages.vector, []);
  ok(result.hits.some(h => h.title === 'apples'));
  eq(result.debug.degraded.embed, true);
  ok(result.debug.notes.some(n => n.includes('模型') && n.includes('重导')));
});

await check('匹配模型的向量索引仍正常参与混合召回', async () => {
  const { entry } = await initial('model-a');
  const result = await retrieve('apples', retrievalDeps(entry, 'model-a'));
  ok(result.debug.stages.vector.length > 0);
  eq(result.debug.degraded.embed, false);
  eq(result.hits[0].title, 'apples');
});

await check('真实召回保留四栏标题与摘要,注入正文与调试结果一致', async () => {
  const { entry } = await initial('model-a');
  const previousHost = globalThis.SillyTavern;
  const writes = [];
  const chat = [
    { is_user: false, mes: '欢迎来到档案馆,我帮你找记录。' },
    { is_user: true, mes: 'apples' },
  ];
  globalThis.SillyTavern = {
    getContext: () => ({ chat, setExtensionPrompt: (...args) => writes.push(args) }),
  };
  try {
    await runRecall(undefined, chat);
    const snap = lastDebug.value;
    ok(snap, '应保存真实召回供调试台查看');
    eq(snap.query, chat.map(m => m.mes).join('\n'), '默认最近三条包含开场白');
    for (const [stage, hits] of Object.entries(snap.stages)) {
      ok(hits.length > 0, `${stage} 应有结果`);
      ok(hits.every(h => h.title && h.preview), `${stage} 不应只有库名与编号`);
      ok(hits.every(h => h.kbId === entry.id));
    }
    ok(lastInjected.value.includes('apples\nRed apples grow on trees.'));
    eq(writes.at(-1)[1], lastInjected.value);

    settings.value.retrieval.queryMessageCount = 1;
    await runRecall(undefined, chat);
    eq(lastDebug.value.query, 'apples', '单条模式只使用最新问题');
  } finally {
    clearInjection();
    globalThis.SillyTavern = previousHost;
  }
});

mock.restoreAll();
done('index');
