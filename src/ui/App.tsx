import { useSignal } from '@preact/signals';

/** P0 外壳:一个悬浮入口 + 一个空面板。库管理 / 设置 / 调试台在 P6 填进 content。 */
export function App() {
  const open = useSignal(false);

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
        <div
          class="srdb-panel"
          onClick={e => {
            // 只有点在遮罩本身(而非面板内容)时才关闭
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
            <div class="srdb-panel__content">
              <p class="srdb-placeholder">知识库管理、端点设置与检索调试台将在此处。</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
