import { render } from 'preact';
import { App } from '@/ui/App';
import { getContext, whenStReady, type StChatMessage } from '@/st/context';
import { hydrateSettings } from '@/settings';
import { clearInjection, runRecall, shouldRecallForType } from '@/inject';
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
 */
(globalThis as Record<string, unknown>).srdb_generateInterceptor = async (
  chat: StChatMessage[],
  _contextSize: number,
  _abort: (immediately: boolean) => void,
  type: string | undefined,
): Promise<void> => {
  // 任何检索异常都不得阻断对话 —— runRecall 内部已全部吞掉,这里再兜一层。
  try {
    if (shouldRecallForType(type)) await runRecall(undefined, chat);
  } catch (e) {
    console.error('[srdb] 拦截器异常(放行本次生成)', e);
  }
};

void whenStReady().then(() => {
  hydrateSettings();
  mount();

  // 切聊天时上一轮的召回结果已经不适用,先清空,等下一次生成重新召回
  const ctx = getContext();
  ctx?.eventSource?.on(ctx.eventTypes.CHAT_CHANGED ?? 'chat_id_changed', () => clearInjection());
  // 停止时也取消检索,避免端点请求继续等待或把迟到的结果写回注入槽。
  ctx?.eventSource?.on(ctx.eventTypes.GENERATION_STOPPED ?? 'generation_stopped', () => clearInjection());
});
