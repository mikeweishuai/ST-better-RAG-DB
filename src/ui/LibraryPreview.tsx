import { useSignal } from '@preact/signals';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import { getChunkPage } from '@/engine/db';
import type { KbEntry } from '@/kb/types';
import { describeError } from '@/retrieve/http';
import { Button } from './controls';

const PAGE_SIZE = 50;

type PreviewResult =
  | { kind: 'ready'; entries: Awaited<ReturnType<typeof getChunkPage>>; hasNext: boolean }
  | { kind: 'error'; message: string };

export function LibraryPreview({ kb, onClose }: { kb: KbEntry; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const pageIndex = useSignal(0);
  const result = useSignal<PreviewResult | null>(null);
  const page = pageIndex.value;
  const current = result.value;
  const hasNext = current?.kind === 'ready' && current.hasNext;

  useLayoutEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);

  useLayoutEffect(() => {
    let active = true;
    result.value = null;
    if (content.current) content.current.scrollTop = 0;

    // 多读一条来判断是否还有下一页，避免为预览扫描全库。
    void getChunkPage(kb.id, page * PAGE_SIZE, PAGE_SIZE + 1).then(rows => {
      if (!active) return;
      result.value = { kind: 'ready', entries: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE };
    }, error => {
      if (active) result.value = { kind: 'error', message: describeError(error) };
    });

    return () => { active = false; };
  }, [kb.id, kb.updatedAt, page]);

  return (
    <dialog
      ref={dialog}
      class="srdb-preview"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={e => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div class="srdb-panel__head srdb-preview__head">
        <h2 class="srdb-preview__title" id={titleId}>{kb.name}</h2>
        <button
          class="srdb-panel__close"
          type="button"
          aria-label="关闭预览"
          autoFocus
          onClick={() => dialog.current?.close()}
        >
          ✕
        </button>
      </div>

      <div class="srdb-preview__content" ref={content} tabIndex={0}>
        {current === null ? (
          <p class="srdb-placeholder" role="status">正在读取条目…</p>
        ) : current.kind === 'error' ? (
          <p class="srdb-testresult is-bad" role="alert">无法读取条目。{current.message}</p>
        ) : current.entries.length ? (
          <ol class="srdb-preview__entries" role="list">
            {current.entries.map(({ ordinal, title, text }) => (
              <li class="srdb-preview__entry" key={ordinal}>
                <h3>{title || `第 ${ordinal + 1} 条`}</h3>
                {text && <p>{text}</p>}
              </li>
            ))}
          </ol>
        ) : (
          <p class="srdb-placeholder" role="status">
            {page === 0 ? '此浏览器中没有该知识库的条目。可重新导入原文件。' : '这一页没有条目。'}
          </p>
        )}
      </div>

      {(page > 0 || hasNext) && (
        <div class="srdb-preview__pages">
          <Button disabled={page === 0} onClick={() => { pageIndex.value = page - 1; }}>上一页</Button>
          <span aria-live="polite">第 {page + 1} 页</span>
          <Button disabled={!hasNext} onClick={() => { pageIndex.value = page + 1; }}>下一页</Button>
        </div>
      )}
    </dialog>
  );
}
