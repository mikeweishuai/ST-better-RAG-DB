/**
 * 运行时状态。与设置(会持久化)分开 —— 这些只活在本次会话,刷新即丢。
 */

import { signal } from '@preact/signals';
import type { BuildProgress } from '../engine/build.ts';
import type { DebugSnapshot } from '../retrieve/pipeline.ts';

/** 最近一次召回的分阶段快照,调试台与「上次召回」面板读它。 */
export const lastDebug = signal<DebugSnapshot | null>(null);

/** 正在建索引的库;null 表示空闲。 */
export const indexing = signal<{ kbId: string; progress: BuildProgress } | null>(null);

/** 最近一次注入的文本,供界面确认「究竟注了什么」。 */
export const lastInjected = signal<string>('');
