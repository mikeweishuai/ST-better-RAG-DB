/**
 * 知识库数据模型。
 *
 * 存储分工:
 *  - 词条正文与向量 → IndexedDB(见 engine/db.ts),体积大,不跨设备。
 *  - 库元数据(名字/条数/指纹/开关)→ extension_settings,几百字节,随 ST settings.json 跨设备同步。
 *    正文绝不进 settings,会把它撑爆。
 */

/** 一条词条。解析产物,正文随索引入 IndexedDB。 */
export interface KbChunk {
  /**
   * 确定性 id:标题存在且库内唯一时用 `<kbId>:t<标题hash>`,否则 `<kbId>:#<序号>`。
   * 优先标题 hash —— 在文件中间插入新词条时,后面各条 id 不位移,重导入只 embed 真正变动的条目。
   */
  id: string;
  title: string;
  text: string;
  /** 入库文本 = `标题\n正文`(标题为空时即正文)。分词、向量化、rerank、注入统一用它。 */
  document: string;
  /** 正文指纹(FNV-1a),变了才重新 embed。 */
  docHash: string;
}

/** 一个已导入的知识库,元数据存进 extension_settings。 */
export interface KbEntry {
  id: string;
  name: string;
  /** 导入时的原始文件名,仅供展示来源。 */
  sourceName: string;
  chunkCount: number;
  /** 整库内容指纹,重复导入同一文件时用于提示「内容无变化」。 */
  contentHash: string;
  /** 单库开关:关掉则不参与召回,索引仍在。 */
  enabled: boolean;
  updatedAt: number;
}
