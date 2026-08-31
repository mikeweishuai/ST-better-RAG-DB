# ST-better-RAG-DB

SillyTavern 知识库插件:**BM25 + embedding 混合检索 + rerank 精排**,生成前自动把相关设定注入提示词。


## 特性

- **混合检索**:关键词(BM25)与语义(embedding)并行召回,RRF 融合排序,再用 rerank 模型精排 —— 专名、术语靠 BM25,近义改写靠向量,两路互补。
- **纯前端索引**:向量以 int8 量化存储、全量扫描,倒排表按词分行存取。无需数据库或后端服务,几万条词条也能在浏览器里跑起来。
- **检索调试台**:四栏并排展示 BM25 / 向量 / 融合 / rerank 各阶段的命中与分数,直观看到"只有关键词命中"或"只有语义命中"的词条,方便调参。

## 安装

```bash
git clone https://github.com/mikeweishuai/ST-better-RAG-DB.git
cd ST-better-RAG-DB
npm install
npm run build
```

将整个仓库目录放入(或软链到)SillyTavern 的第三方扩展目录:

```
SillyTavern/public/scripts/extensions/third-party/ST-better-RAG-DB/
```

刷新 SillyTavern 页面,扩展面板里会出现一个悬浮入口。

## 使用

1. 打开扩展面板 → **端点** 页,分别填写 embedding 与 rerank 服务的地址、API Key、模型名,点"连通性测试"确认可用。
   - 只填 embedding 不填 rerank:仍会检索,只是不做精排。
   - 两者都不填:退化为纯 BM25 关键词检索。
2. 切到 **知识库** 页,导入设定文档(支持 `.txt` / `.md` / `.json`)。md 按标题切条,txt 按空行或分隔线切条,json 支持字符串数组/对象数组/对象字典三种形状。
3. 在 **参数** 页调整召回数量、融合方式(RRF 或加权归一化)、rerank 阈值、注入深度与字符预算。
4. 用 **调试台** 输入一句查询(建议试试包含专有名词的句子),对照四栏命中结果验证检索效果。
5. 正常对话即可,扩展会在每次生成前自动检索并把结果注入提示词。

## 依赖

默认假设已安装:

- [JS-Slash-Runner](https://github.com/N0VI028/JS-Slash-Runner)
- [ST-Prompt-Template](https://github.com/zonde306/ST-Prompt-Template)

本插件不直接依赖它们的 API,但作为酒馆知识库场景的常见搭配一并说明。


## 已知限制

- `Intl.Segmenter` 的中文分词质量依赖运行环境的 ICU 实现,复合词(如人名、专有名词)可能被切得过细。调试台的"分词"一行可直接观察实际切分效果。
- 单库建议规模上限约 5 万词条(int8 量化向量常驻内存的实际约束)。

## License

未指定。
