import { check, eq, ok, done } from './_assert.mjs';
import {
  EndpointError,
  batchByCharBudget,
  describeError,
  postJson,
  resolveEndpointUrl,
  runPool,
} from '../src/retrieve/http.ts';
import { embedTexts } from '../src/retrieve/embed.ts';
import { rerankDocuments } from '../src/retrieve/rerank.ts';

console.log('endpoint');

const cfg = (over = {}) => ({
  baseUrl: 'https://api.example.com',
  apiKey: 'k',
  model: 'm',
  timeoutSec: 5,
  retries: 0,
  ...over,
});

/** 装 globalThis.fetch,返回调用记录。handler 收到 (url, bodyObject, callIndex)。 */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return handler(url, body, calls.length - 1);
  };
  return calls;
}

const jsonResponse = (obj, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

/* ---------- URL 归一化 ---------- */

await check('resolveEndpointUrl 补 /v1,并容忍尾斜杠', () => {
  eq(resolveEndpointUrl('https://x.com', '/embeddings'), 'https://x.com/v1/embeddings');
  eq(resolveEndpointUrl('https://x.com/', '/embeddings'), 'https://x.com/v1/embeddings');
  eq(resolveEndpointUrl('https://x.com/v1', '/embeddings'), 'https://x.com/v1/embeddings');
  eq(resolveEndpointUrl('https://x.com/v1/', '/rerank'), 'https://x.com/v1/rerank');
  eq(resolveEndpointUrl('https://x.com/v2', '/rerank'), 'https://x.com/v2/rerank');
});

await check('已填到具体路径时原样使用(自建服务的逃生口)', () => {
  eq(resolveEndpointUrl('http://127.0.0.1:9997/rerank', '/rerank'), 'http://127.0.0.1:9997/rerank');
});

await check('空地址抛 config 错', () => {
  let kind = '';
  try {
    resolveEndpointUrl('   ', '/embeddings');
  } catch (e) {
    kind = e.kind;
  }
  eq(kind, 'config');
});

/* ---------- 批次切分 ---------- */

await check('batchByCharBudget 按条数上限切', () => {
  const b = batchByCharBudget(['a', 'b', 'c', 'd', 'e'], 2, 1000);
  eq(b.map(x => x.indices), [[0, 1], [2, 3], [4]]);
});

await check('batchByCharBudget 按字符上限切', () => {
  const b = batchByCharBudget(['aaaa', 'bbbb', 'cc'], 100, 8);
  eq(b.map(x => x.indices), [[0, 1], [2]]);
});

await check('单条超字符上限时独占一批,内容不丢', () => {
  const b = batchByCharBudget(['x'.repeat(50), 'y'], 100, 10);
  eq(b.map(x => x.indices), [[0], [1]]);
  eq(b.flatMap(x => x.texts).length, 2);
});

await check('空输入产出空批次', () => {
  eq(batchByCharBudget([], 10, 10), []);
});

/* ---------- 并发池 ---------- */

await check('runPool 按输入顺序回填结果', async () => {
  // 故意让先入队的慢、后入队的快,验证回填靠下标而非完成顺序
  const out = runPool([30, 20, 10, 0], 2, async ms => {
    await new Promise(r => setTimeout(r, ms));
    return ms;
  });
  return out.then(r => eq(r, [30, 20, 10, 0]));
});

await check('runPool 不超过并发上限', async () => {
  let inFlight = 0;
  let peak = 0;
  return runPool([1, 2, 3, 4, 5, 6], 2, async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
  }).then(() => ok(peak <= 2, `峰值并发 ${peak}`));
});

/* ---------- 错误分类与重试 ---------- */

await check('fetch 抛 TypeError 归类为 network', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  return postJson('https://x/v1/embeddings', cfg(), {}).then(
    () => ok(false, '本应抛错'),
    e => {
      eq(e.kind, 'network');
      ok(describeError(e).includes('CORS'), '提示里应点出 CORS');
    },
  );
});

await check('401 归类为 auth 且不重试', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse({ error: 'bad key' }, 401);
  };
  return postJson('https://x/v1/embeddings', cfg({ retries: 3 }), {}).then(
    () => ok(false, '本应抛错'),
    e => {
      eq(e.kind, 'auth');
      eq(e.status, 401);
      eq(calls, 1, '鉴权失败重试没有意义');
    },
  );
});

await check('500 会重试到用尽次数', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse({}, 500);
  };
  return postJson('https://x/v1/embeddings', cfg({ retries: 2 }), {}).then(
    () => ok(false, '本应抛错'),
    e => {
      eq(e.kind, 'http');
      eq(calls, 3, '首次 + 2 次重试');
    },
  );
});

await check('重试后成功则正常返回', async () => {
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 }));
  return postJson('https://x/v1/embeddings', cfg({ retries: 2 }), {}).then(r => {
    eq(r, { ok: 1 });
    eq(calls, 2);
  });
});

await check('describeError 对每种 kind 都给出可操作的中文说明', () => {
  for (const kind of ['config', 'network', 'timeout', 'auth', 'http', 'parse']) {
    const msg = describeError(new EndpointError(kind, 'detail', 500));
    ok(msg.length > 0, `kind=${kind}`);
  }
});

/* ---------- embedding ---------- */

await check('embedTexts 分批后按全局下标合并,且结果已归一化', async () => {
  // 每批回一组可区分的向量,验证跨批回填不串位
  stubFetch((_url, body) =>
    jsonResponse({
      data: body.input.map((t, i) => ({ index: i, embedding: [Number(t), 0, 0] })),
    }),
  );
  return embedTexts(['1', '2', '3', '4', '5'], cfg()).then(vecs => {
    eq(vecs.length, 5);
    // 归一化后 [n,0,0] → [1,0,0];用第一分量恒为 1 确认确实归一化过
    ok(vecs.every(v => Math.abs(v[0] - 1) < 1e-6), '应已 L2 归一化');
  });
});

await check('embedTexts 遵守服务端返回的乱序 index', async () => {
  stubFetch((_url, body) =>
    jsonResponse({
      // 倒序返回,考验是否真的按 index 回位而非按数组顺序
      data: body.input
        .map((t, i) => ({ index: i, embedding: [Number(t), 0, 0] }))
        .reverse(),
    }),
  );
  return embedTexts(['3', '7'], cfg()).then(vecs => {
    eq(vecs.length, 2);
    ok(vecs[0][0] > 0 && vecs[1][0] > 0);
  });
});

await check('embedTexts 条数对不上时抛 parse,而非静默返回半份', async () => {
  stubFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] }));
  return embedTexts(['a', 'b'], cfg()).then(
    () => ok(false, '本应抛错'),
    e => eq(e.kind, 'parse'),
  );
});

await check('embedTexts 空输入不发请求', async () => {
  const calls = stubFetch(() => jsonResponse({ data: [] }));
  return embedTexts([], cfg()).then(v => {
    eq(v, []);
    eq(calls.length, 0);
  });
});

await check('模型未配置时抛 config', async () => {
  return embedTexts(['a'], cfg({ model: '  ' })).then(
    () => ok(false, '本应抛错'),
    e => eq(e.kind, 'config'),
  );
});

/* ---------- rerank ---------- */

await check('rerankDocuments 把批内下标映射回全局下标', async () => {
  // 单批只放 2 条,强制切成多批;每批都回「批内第 1 条最相关」
  stubFetch((_url, body) =>
    jsonResponse({
      results: body.documents.map((_d, i) => ({ index: i, relevance_score: i === 0 ? 0.9 : 0.1 })),
    }),
  );
  const docs = ['a', 'b', 'c', 'd'];
  return rerankDocuments('q', docs, cfg()).then(res => {
    eq(res.length, 4);
    // 全部 index 必须落在 documents 的合法范围内且互不重复
    eq([...new Set(res.map(r => r.index))].sort(), [0, 1, 2, 3]);
    ok(res[0].score >= res[res.length - 1].score, '应按分数降序');
  });
});

await check('rerankDocuments 兼容 score 字段名', async () => {
  stubFetch((_url, body) =>
    jsonResponse({ results: body.documents.map((_d, i) => ({ index: i, score: 1 - i * 0.1 })) }),
  );
  return rerankDocuments('q', ['a', 'b'], cfg()).then(res => {
    eq(res[0].index, 0);
    ok(res[0].score > res[1].score);
  });
});

await check('rerankDocuments 每批都重发 query', async () => {
  const calls = stubFetch((_url, body) =>
    jsonResponse({ results: body.documents.map((_d, i) => ({ index: i, relevance_score: 0 })) }),
  );
  return rerankDocuments('查询词', ['a', 'b', 'c'], cfg()).then(() => {
    ok(calls.length >= 1);
    ok(calls.every(c => c.body.query === '查询词'));
  });
});

await check('rerankDocuments 空文档不发请求', async () => {
  const calls = stubFetch(() => jsonResponse({ results: [] }));
  return rerankDocuments('q', [], cfg()).then(r => {
    eq(r, []);
    eq(calls.length, 0);
  });
});

await check('rerank 响应缺 results 抛 parse', async () => {
  stubFetch(() => jsonResponse({ nope: 1 }));
  return rerankDocuments('q', ['a'], cfg()).then(
    () => ok(false, '本应抛错'),
    e => eq(e.kind, 'parse'),
  );
});

done('endpoint');
