declare global {
  /** 由 vite define 注入,取自 package.json。 */
  const __SRDB_VERSION__: string;

  interface Window {
    /** ST 在 script.js 末尾挂出的对外接口:`globalThis.SillyTavern = { libs, getContext }`。 */
    SillyTavern?: { getContext: () => unknown };
    /** ST 全局引入的 toastr,用于提示。 */
    toastr?: {
      info: (msg: string, title?: string) => void;
      success: (msg: string, title?: string) => void;
      warning: (msg: string, title?: string) => void;
      error: (msg: string, title?: string) => void;
    };
  }
}

export {};
