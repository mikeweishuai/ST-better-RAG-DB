import { render } from 'preact';
import { App } from '@/ui/App';
import { whenStReady } from '@/st/context';
// ?inline 拿到 CSS 字符串,直接塞进 shadow root(见 styles/base.css 顶部说明)
import baseCss from '@/styles/base.css?inline';

const HOST_ID = 'srdb-app-host';

/**
 * 可继承的排版属性不被 shadow DOM 隔离,会从 ST 的样式漏进来。
 * 在 host 上用内联 !important 钉死,从根上切断继承链。
 */
const INHERITED_RESET: Record<string, string> = {
  'font-family':
    "'MiSans','HarmonyOS Sans SC','PingFang SC','Microsoft YaHei',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
  'font-size': '14px',
  'font-weight': '400',
  'font-style': 'normal',
  'line-height': '1.6',
  'letter-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  direction: 'ltr',
};

function mount(): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  for (const [prop, value] of Object.entries(INHERITED_RESET)) {
    host.style.setProperty(prop, value, 'important');
  }
  document.body.append(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = baseCss;
  shadow.append(style);

  const mountPoint = document.createElement('div');
  shadow.append(mountPoint);
  render(<App />, mountPoint);
}

/**
 * 生成拦截器:ST 每次生成前会 await 调用 manifest.generate_interceptor 指名的全局函数,
 * 签名 (chat, contextSize, abort, type)。被 await 意味着可以在这里跑完整的异步检索管线,
 * 写完注入槽再放行,不存在「注入赶不上这一轮生成」的竞态。
 *
 * P0 先占位;检索与注入在 P4/P5 接进来。
 */
(globalThis as Record<string, unknown>).srdb_generateInterceptor = async (
  _chat: unknown,
  _contextSize: number,
  _abort: (immediately: boolean) => void,
  _type: string | undefined,
): Promise<void> => {
  // 任何检索异常都不得阻断对话 —— 这里统一吞掉,失败即当作「本轮无召回」。
};

void whenStReady().then(mount);
