/**
 * 设置持久化。
 *
 * 存进 ST 的 `extension_settings`(落到服务器 settings.json,跨设备同步),只放元数据:
 * 库名、条数、指纹、开关、端点配置,几百字节。词条正文与向量一律在 IndexedDB ——
 * 正文进 settings 会把它撑爆。
 *
 * `ready` 守门:ST 就绪后先从服务器读到真实值,之后才放行回写。
 * 否则模块初始化时的默认值会在用户还没看到界面前就覆盖掉服务器已存配置。
 */

import { signal } from '@preact/signals';
import { getContext } from './st/context.ts';
import type { EndpointConfig } from './retrieve/http.ts';
import type { KbEntry } from './kb/types.ts';

export const SETTINGS_KEY = 'st_better_rag_db';

export interface RetrievalSettings {
  /** query 取最近多少条消息拼接 */
  queryMessageCount: number;
  bm25TopN: number;
  vectorTopN: number;
  fuseTopN: number;
  rerankTopK: number;
  rrfK: number;
  fusionMode: 'rrf' | 'weighted';
  /** 仅 weighted 模式使用 */
  weights: { bm25: number; vector: number };
  bm25: { k1: number; b: number };
  /** rerank 成功时的准入阈值 */
  rerankThreshold: number;
  /** rerank 失败降级为融合序时的准入阈值 —— 两种分数尺度不可比,不能共用 */
  fuseThreshold: number;
}

export interface InjectionSettings {
  depth: number;
  charBudget: number;
}

export interface SrdbSettings {
  enabled: boolean;
  embedding: EndpointConfig;
  rerank: EndpointConfig;
  retrieval: RetrievalSettings;
  injection: InjectionSettings;
  kbs: KbEntry[];
}

function defaultEndpoint(): EndpointConfig {
  return { baseUrl: '', apiKey: '', model: '', timeoutSec: 30, retries: 2 };
}

export function defaultSettings(): SrdbSettings {
  return {
    enabled: true,
    embedding: defaultEndpoint(),
    rerank: defaultEndpoint(),
    retrieval: {
      queryMessageCount: 3,
      bm25TopN: 100,
      vectorTopN: 100,
      fuseTopN: 50,
      rerankTopK: 5,
      rrfK: 60,
      fusionMode: 'rrf',
      weights: { bm25: 1, vector: 1 },
      bm25: { k1: 1.2, b: 0.75 },
      rerankThreshold: 0.3,
      fuseThreshold: 0,
    },
    injection: { depth: 4, charBudget: 2000 },
    kbs: [],
  };
}

export const settings = signal<SrdbSettings>(defaultSettings());

let ready = false;

/** 只在字段类型对得上时采用存量值,坏数据回落默认值而非让界面崩掉。 */
function mergeSettings(stored: unknown): SrdbSettings {
  const base = defaultSettings();
  if (!stored || typeof stored !== 'object') return base;
  const s = stored as Partial<SrdbSettings>;

  const endpoint = (v: unknown, d: EndpointConfig): EndpointConfig => {
    if (!v || typeof v !== 'object') return d;
    const e = v as Partial<EndpointConfig>;
    return {
      baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl : d.baseUrl,
      apiKey: typeof e.apiKey === 'string' ? e.apiKey : d.apiKey,
      model: typeof e.model === 'string' ? e.model : d.model,
      timeoutSec: typeof e.timeoutSec === 'number' ? e.timeoutSec : d.timeoutSec,
      retries: typeof e.retries === 'number' ? e.retries : d.retries,
    };
  };

  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : base.enabled,
    embedding: endpoint(s.embedding, base.embedding),
    rerank: endpoint(s.rerank, base.rerank),
    retrieval: { ...base.retrieval, ...(typeof s.retrieval === 'object' ? s.retrieval : {}) },
    injection: { ...base.injection, ...(typeof s.injection === 'object' ? s.injection : {}) },
    kbs: Array.isArray(s.kbs) ? s.kbs : base.kbs,
  };
}

/** ST 就绪后调用一次:载入服务器已存设置,并放行后续回写。 */
export function hydrateSettings(): void {
  const ctx = getContext();
  if (!ctx) return;
  settings.value = mergeSettings(ctx.extensionSettings[SETTINGS_KEY]);
  ready = true;
}

/** 回写。hydrate 之前调用一律忽略 —— 这是守门的全部意义。 */
export function persistSettings(): void {
  if (!ready) return;
  const ctx = getContext();
  if (!ctx) return;
  ctx.extensionSettings[SETTINGS_KEY] = settings.value;
  ctx.saveSettingsDebounced();
}

/** 改设置的统一入口:改完即持久化,免得漏调 persist。 */
export function updateSettings(mutate: (draft: SrdbSettings) => void): void {
  // 浅拷一层顶层字段,让 signal 的订阅者能感知变化
  const draft: SrdbSettings = {
    ...settings.value,
    embedding: { ...settings.value.embedding },
    rerank: { ...settings.value.rerank },
    retrieval: {
      ...settings.value.retrieval,
      weights: { ...settings.value.retrieval.weights },
      bm25: { ...settings.value.retrieval.bm25 },
    },
    injection: { ...settings.value.injection },
    kbs: [...settings.value.kbs],
  };
  mutate(draft);
  settings.value = draft;
  persistSettings();
}
