import { useSignal } from '@preact/signals';
import { useRef } from 'preact/hooks';
import { settings } from '@/settings';
import { importKbFromFile, removeKb, renameKb, setKbEnabled } from '@/kb/manage';
import { CHUNK_COUNT_WARN, isCancelled, type BuildProgress } from '@/engine/build';
import { describeError } from '@/retrieve/http';
import { indexing } from '@/state/runtime';
import { Button, Section, TextInput, Toggle } from './controls';

const PHASE_LABEL: Record<BuildProgress['phase'], string> = {
  diff: '对账',
  embedding: '向量化',
  quantize: '量化',
  postings: '建倒排',
  writing: '落库',
  done: '完成',
};

function ProgressBar({ p }: { p: BuildProgress }) {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <div class="srdb-progress">
      <div class="srdb-progress__bar" style={{ width: `${pct}%` }} />
      <span class="srdb-progress__text">
        {PHASE_LABEL[p.phase]} {p.total > 0 ? `${p.done}/${p.total}` : ''}
      </span>
    </div>
  );
}

export function Libraries() {
  const fileInput = useRef<HTMLInputElement>(null);
  const message = useSignal<{ kind: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const abort = useSignal<AbortController | null>(null);
  /** 非空时表示这次选文件是要重导到该库,而不是新建 */
  const reimportTarget = useSignal<string | null>(null);

  const busy = indexing.value !== null;

  const pick = (kbId: string | null) => {
    reimportTarget.value = kbId;
    fileInput.current?.click();
  };

  const onFile = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // 允许连续选同一个文件
    if (!file) return;

    const kbId = reimportTarget.value;
    const controller = new AbortController();
    abort.value = controller;
    message.value = null;

    try {
      const outcome = await importKbFromFile(file, {
        ...(kbId ? { kbId } : {}),
        signal: controller.signal,
        onProgress: progress => {
          indexing.value = { kbId: kbId ?? '(new)', progress };
        },
      });

      if (outcome.status === 'unchanged') {
        message.value = { kind: 'info', text: `「${outcome.entry.name}」内容无变化,索引未改动` };
      } else {
        const r = outcome.report;
        const detail = r.bm25Only
          ? '(未配置 Embedding,只建了 BM25 索引)'
          : `,新向量化 ${r.embedded} 条、复用 ${r.reused} 条,维度 ${r.dim}`;
        message.value = { kind: 'ok', text: `「${outcome.entry.name}」共 ${r.chunkCount} 条${detail}` };
        if (r.chunkCount > CHUNK_COUNT_WARN) {
          message.value = {
            kind: 'info',
            text: `${message.value.text}。词条数超过 ${CHUNK_COUNT_WARN},向量矩阵常驻内存可能较大,留意浏览器占用。`,
          };
        }
      }
    } catch (err) {
      message.value = isCancelled(err)
        ? { kind: 'info', text: '已取消' }
        : { kind: 'bad', text: describeError(err) };
    } finally {
      indexing.value = null;
      abort.value = null;
      reimportTarget.value = null;
    }
  };

  return (
    <div>
      <input
        ref={fileInput}
        type="file"
        accept=".txt,.md,.markdown,.json"
        style={{ display: 'none' }}
        onChange={onFile}
      />

      <Section title="知识库" note="支持 .txt / .md / .json。md 按标题切条,txt 按空行或分隔行切条。">
        <div class="srdb-row srdb-row--end">
          <Button variant="primary" disabled={busy} onClick={() => pick(null)}>
            导入文件
          </Button>
          {busy && <Button variant="danger" onClick={() => abort.value?.abort()}>取消</Button>}
        </div>

        {indexing.value && <ProgressBar p={indexing.value.progress} />}

        {message.value && (
          <p class={`srdb-testresult is-${message.value.kind === 'bad' ? 'bad' : message.value.kind === 'ok' ? 'ok' : 'info'}`}>
            {message.value.text}
          </p>
        )}

        {!settings.value.kbs.length && <p class="srdb-placeholder">还没有导入任何知识库。</p>}

        <ul class="srdb-kblist">
          {settings.value.kbs.map(kb => (
            <li class="srdb-kb" key={kb.id}>
              <div class="srdb-kb__main">
                <TextInput value={kb.name} onCommit={v => renameKb(kb.id, v)} />
                <div class="srdb-kb__meta">
                  {kb.chunkCount} 条 · 来自 {kb.sourceName} · 指纹 {kb.contentHash}
                </div>
              </div>
              <div class="srdb-kb__actions">
                <Toggle
                  checked={kb.enabled}
                  label={kb.enabled ? '参与召回' : '已停用'}
                  onToggle={v => setKbEnabled(kb.id, v)}
                />
                <Button disabled={busy} onClick={() => pick(kb.id)}>
                  重导
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    void removeKb(kb.id).then(() => {
                      message.value = { kind: 'info', text: `已删除「${kb.name}」` };
                    });
                  }}
                >
                  删除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
