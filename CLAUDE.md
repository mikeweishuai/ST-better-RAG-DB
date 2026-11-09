# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SillyTavern 第三方前端扩展:把用户导入的设定文档建成 **BM25 + embedding 混合索引**,
在每次生成前检索、rerank,并注入提示词。Preact + Vite + TypeScript,索引全部在浏览器 IndexedDB。

代码注释用简体中文,解释「为什么」而非「做什么」。回复用中文。

## 命令

```bash
npm run build          # vite build → dist/(prebuild 会同步版本号进 manifest.json)
npm run watch          # 开发监听
npm run typecheck      # tsc --noEmit
npm test               # 全部 9 个套件
npm run test:bm25      # 单个套件:test:{tokenize,bm25,fuse,quantize,parse,endpoint,inject,db,index}
```

单测是零框架 node 脚本,靠 `node --experimental-strip-types` 直接加载 `.ts`。断言助手在
`scripts/_assert.mjs`,用例一律 `await check('名字', fn)`(fn 可同步可异步),结尾 `done('套件名')`。
需要 Node 22.14+。存储回归用开发依赖 `fake-indexeddb`,不读取浏览器真实数据;
索引集成回归仅模拟 Worker 与 HTTP 边界,通过 Node 内置的实验性模块 mock 加载。

**没有 lint。** 类型检查 + 单测就是全部门禁。

## 三条会静默出错的约束

改到这些地方时格外当心 —— 它们出错时不报错,只是行为悄悄变了。

1. **`vite.config.ts` 的 `base: './'` 是承重的。** 默认的 `'/'` 会把 Worker 写成站点根绝对路径
   `/assets/worker-xxx.js`,而扩展实际挂在 `/scripts/extensions/third-party/<name>/dist/` 下,
   运行时静默 404、索引构建永远不返回。改完 vite 配置务必 `grep "new Worker" dist/index.js` 确认是相对路径。

2. **`dist/` 必须提交。** ST 直接加载 `dist/index.js`,不会替你构建。

3. **rerank 阈值与融合阈值不能共用。** 两种分数尺度完全不可比(rerank 通常 0~1,RRF 分数
   量级在 0.0x)。`pipeline.ts` 在 rerank 失败降级时会同步把 `threshold` 从 `rerankThreshold`
   切到 `fuseThreshold`,共用一个必然要么全放行要么全过滤。

## 与宿主 SillyTavern 的边界

**不 import ST 的任何模块。** 全部能力经 `globalThis.SillyTavern.getContext()` 获取,
封装在 [src/st/context.ts](src/st/context.ts) 里。这让构建产物与 ST 的目录层级解耦,
仓库放在 ST 目录之外也能构建。`extension_prompt_types` / `extension_prompt_roles` 这类
纯数字枚举在该文件里本地重声明(值稳定)。

两个接触点:

- **`manifest.json` 的 `generate_interceptor: "srdb_generateInterceptor"`** → 在
  [src/index.tsx](src/index.tsx) 挂到 `globalThis`。ST 会 **await** 这个函数
  (`public/scripts/extensions.js` 的 `runGenerationInterceptors`),所以整条异步检索管线
  可以跑完再放行,不存在「注入赶不上本轮生成」的竞态。
- **`setExtensionPrompt(key, text, IN_CHAT, depth, false, SYSTEM, null)`** → 同一 key 重复写即覆盖,
  写空串即清空。

本机有 ST 源码可供核对 API:`C:\Dev\SillyTavern`(1.15.0)。改动涉及宿主 API 时**去读源码,别凭记忆**。

## 数据流

**导入**:`kb/manage.ts` → `kb/parse.ts` 切条 → `engine/build.ts` 编排 →
(分词/倒排/量化在 `engine/worker.ts`,embedding 请求在主线程发)→ 三个 IndexedDB 表。

**召回**:拦截器 → `inject.ts:runRecall` → `retrieve/pipeline.ts`
(BM25 ∥ 向量 → RRF 融合 → rerank → 阈值 → 字符预算)→ `setExtensionPrompt`。

**召回路径永不抛错。** 任何检索异常都只能导致本轮无注入,绝不能阻断对话。
`pipeline.ts` 内部逐路降级(embed 挂了只剩 BM25,rerank 挂了用融合序),
`runRecall` 再兜一层,拦截器还有第三层。

## 索引设计里几个反直觉的决定

- **向量按 int8 对称量化存**(`engine/quantize.ts`)。浏览器没有 ANN,只能全量扫描;
  1024 维 × 5 万条 Float32 是 200MB 扛不住,int8 是 50MB 可常驻内存。入库前先 L2 归一化,
  此时点积即余弦。查询向量**不量化** —— 少一次误差且成本相同。
- **倒排表按 term 分行存**(`postings` keyPath `[kbId, term]`)。查询只读 query 分词后那
  几十个 term 的行,不反序列化整个索引 —— 这是每轮生成前跑得起 BM25 的前提。
- **ordinal 每次重建都会重排**,所以倒排表只能按库整体重写,不能增量更新。
  `replaceKbIndex` 在同一个 IndexedDB 事务内替换 chunks、postings、kbmeta,
  同步写入异常必须主动 abort,异步失败必须等事务回滚;提交成功后才失效向量缓存。
- **chunkId 的稳定性 = 增量 embed 的正确性**。id 优先用标题 hash(`<kbId>:t<fnv1a(title)>`),
  这样在文件中间插入新词条时后面各条 id 不位移,重导只需 embed 真正变动的条目。
  标题重复时退回序号 id,否则同名词条互相覆盖。
- **重建杠杆**:`TOKENIZER_VERSION`(分词口径变了 → 倒排作废)与 `embedModel`
  (换模型 → 向量作废),见 `engine/build.ts:needsRebuild`。
- **BM25-only 是受支持的状态**。未配置 embedding 照样建索引、照样检索,不是错误路径。
  BM25-only 重建不能沿用旧模型标记,否则重新启用 embedding 后无法补齐新条目的向量。

重导不能仅凭内容指纹返回 unchanged:还须用 `needsRebuild` 检查本地索引、分词版本、
模型及向量维度。召回时也须核对索引的模型名,同维度不代表相同向量空间。

## 存储分工

- **`extension_settings['st_better_rag_db']`** 只放元数据(库名、条数、指纹、开关、端点配置),
  几百字节,随 ST 的 `settings.json` 跨设备同步。**正文与向量绝不进这里**,会把它撑爆。
- **IndexedDB** 放词条正文、量化向量、倒排表。

`settings.ts` 有 **`ready` 守门**:ST 就绪后先 `hydrateSettings()` 从服务器读到真实值,
之后才放行回写。否则模块初始化时的默认值会在用户看到界面前覆盖掉已存配置。
改设置一律走 `updateSettings(draft => ...)`,它负责浅拷贝 + 持久化。

拦截器传来的 chat 是宿主为本轮处理过的聊天,召回应使用它,不能改读完整 `ctx.chat`
(swipe 时后者仍包含要被替换的回答)。`clearInjection` 同时取消在途召回并使旧轮次失效;
CHAT_CHANGED 和 GENERATION_STOPPED 都应调用它,避免迟到结果污染新聊天。

## 导入约定(影响单测能否运行)

- **`@/` 别名只在 UI 与入口用**(`src/index.tsx`、`src/ui/*`)。
- **`src/engine`、`src/kb`、`src/retrieve`、`src/settings.ts`、`src/inject.ts` 用相对路径,
  且必须带 `.ts` 扩展名。** Node 的 ESM 解析要求显式扩展名,这条约定让这些模块能被单测直接加载。
  `tsconfig.json` 因此开了 `allowImportingTsExtensions`。
- 纯函数不读 `settings`,配置一律作参数传入(见 `pipeline.ts` 的 `PipelineDeps`)——
  调试台要能用一组临时参数试跑而不影响线上召回。

## Preact / Shadow DOM

UI 渲染在 shadow root 内(`src/index.tsx` 的 `mount`)。

- **`onChange` 是原生 change 事件**(Preact 不像 React 那样重映射到 input),失焦或回车才触发。
  表单件正是靠这一点让用户中途敲出的临时非法值不被立刻归一化回去。见 `src/ui/controls.tsx`。
- **不要用 `createPortal` 往 `document.body` 送弹窗** —— 会飞出 shadow root 丢掉全部样式。
  弹窗在 shadow 内用 `position: fixed` 内联渲染。
- 样式经 `?inline` 以字符串打进 bundle 再塞进 shadow root,省掉运行时 fetch。
- 继承型排版属性(font-family / font-size / line-height 等)不被 shadow 隔离,
  在 host 元素上用内联 `!important` 钉死(`INHERITED_RESET`)。

## 本机联调

仓库已通过目录联接装进本机 ST:

```
C:\Dev\SillyTavern\public\scripts\extensions\third-party\ST-better-RAG-DB  →  本仓库
```

`npm run watch` 后刷新 ST 页面即可。移除联接用 `rmdir`(不会碰源文件)。
`manifest.json` 的 `js` 字段带 `?ver=`,`sync-version.mjs` 在 prebuild 时同步,用于打破浏览器缓存。

## 已知待验证

`Intl.Segmenter` 的中文分词质量取决于运行环境的 ICU。Node 侧实测偏弱
(`青梅竹马` → `青梅/竹/马`、`东京都` → `东/京都`),浏览器 ICU 通常更好但**尚未实测**。
调试台的「分词」那行会直接显示真实环境的切分结果。若浏览器同样偏弱,补救方案是在
Segmenter 分词之外额外为相邻 CJK 单字补一层二元(倒排约涨 1.8 倍),
bump `TOKENIZER_VERSION` 即可触发全库重建。
