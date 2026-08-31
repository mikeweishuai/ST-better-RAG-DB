import { useSignal } from '@preact/signals';
import { DebugConsole } from './DebugConsole';
import { Endpoints } from './Endpoints';
import { Libraries } from './Libraries';
import { Params } from './Params';

const TABS = [
  { id: 'kb', label: '知识库' },
  { id: 'endpoints', label: '端点' },
  { id: 'params', label: '参数' },
  { id: 'debug', label: '调试台' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function App() {
  const open = useSignal(false);
  const tab = useSignal<TabId>('kb');

  return (
    <div class="srdb-root">
      <button
        class="srdb-launcher"
        title="Better RAG DB"
        onClick={() => {
          open.value = true;
        }}
      >
        📚
      </button>

      {open.value && (
        // 弹窗在 shadow 内用 position: fixed 内联渲染。不能用 createPortal 送去 document.body:
        // 那会飞出 shadow root,丢掉全部样式。
        <div
          class="srdb-panel"
          onClick={e => {
            if (e.target === e.currentTarget) open.value = false;
          }}
        >
          <div class="srdb-panel__body">
            <div class="srdb-panel__head">
              <div class="srdb-panel__title">
                Better RAG DB
                <span class="srdb-panel__version">v{__SRDB_VERSION__}</span>
              </div>
              <button
                class="srdb-panel__close"
                onClick={() => {
                  open.value = false;
                }}
              >
                ✕
              </button>
            </div>

            <nav class="srdb-tabs">
              {TABS.map(t => (
                <button
                  key={t.id}
                  class={`srdb-tab ${tab.value === t.id ? 'is-active' : ''}`}
                  onClick={() => {
                    tab.value = t.id;
                  }}
                >
                  {t.label}
                </button>
              ))}
            </nav>

            <div class="srdb-panel__content">
              {tab.value === 'kb' && <Libraries />}
              {tab.value === 'endpoints' && <Endpoints />}
              {tab.value === 'params' && <Params />}
              {tab.value === 'debug' && <DebugConsole />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
