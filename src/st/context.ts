/**
 * 宿主 SillyTavern 的唯一接触面。
 *
 * 全部能力经 `globalThis.SillyTavern.getContext()` 获取,不 import ST 的任何模块 ——
 * 这样构建产物与 ST 的目录层级解耦,仓库放在 ST 之外也能构建。
 * 只声明本扩展实际用到的字段,其余留给宿主。
 */

/** setExtensionPrompt 的 position 枚举(script.js:452,值稳定)。 */
export const PROMPT_POSITION = {
  NONE: -1,
  IN_PROMPT: 0,
  IN_CHAT: 1,
  BEFORE_PROMPT: 2,
} as const;

/** setExtensionPrompt 的 role 枚举(script.js:462,值稳定)。 */
export const PROMPT_ROLE = {
  SYSTEM: 0,
  USER: 1,
  ASSISTANT: 2,
} as const;

/** ST 的一条聊天消息(只列本扩展读取的字段)。 */
export interface StChatMessage {
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  mes?: string;
}

export interface StEventSource {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

/** getContext() 返回对象中本扩展用到的部分。 */
export interface StContext {
  chat: StChatMessage[];
  characterId: string | number | undefined;
  extensionSettings: Record<string, unknown>;
  saveSettingsDebounced: () => void;
  setExtensionPrompt: (
    key: string,
    value: string,
    position: number,
    depth: number,
    scan?: boolean,
    role?: number,
    filter?: (() => boolean) | null,
  ) => void;
  eventSource: StEventSource;
  eventTypes: Record<string, string>;
}

/** 宿主未就绪时返回 null;所有调用点都必须处理这种情况。 */
export function getContext(): StContext | null {
  const st = (globalThis as typeof globalThis & Window).SillyTavern;
  if (!st || typeof st.getContext !== 'function') return null;
  try {
    return st.getContext() as StContext;
  } catch {
    return null;
  }
}

/**
 * 等 ST 就绪。
 *
 * ST 的 eventSource 以 `new EventEmitter([APP_READY])` 构造 —— APP_READY 属于「已触发过也会
 * 补发给后注册监听者」的事件,所以这里无论早注册还是晚注册都能拿到,不需要轮询。
 * 极端情况下 SillyTavern 全局还没挂出来,退化为短间隔轮询等它出现。
 */
export function whenStReady(): Promise<StContext> {
  return new Promise(resolve => {
    const tryBind = (): boolean => {
      const ctx = getContext();
      if (!ctx?.eventSource) return false;
      ctx.eventSource.on(ctx.eventTypes.APP_READY ?? 'app_ready', () => {
        resolve(getContext() ?? ctx);
      });
      return true;
    };

    if (tryBind()) return;
    const timer = setInterval(() => {
      if (tryBind()) clearInterval(timer);
    }, 100);
  });
}

export function toast(): NonNullable<Window['toastr']> | null {
  return (globalThis as typeof globalThis & Window).toastr ?? null;
}
