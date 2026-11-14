import { useSignal } from '@preact/signals';
import { settings } from '@/settings';
import { retrieve, type DebugSnapshot, type StageHit } from '@/retrieve/pipeline';
import { describeError } from '@/retrieve/http';
import { buildQuery } from '@/inject';
import { getContext } from '@/st/context';
import { lastDebug } from '@/state/runtime';
import { Button, Section } from './controls';

/**
 * 检索调试台。
 *
 * 四栏并排是这个界面存在的全部理由:混合检索是否真的比单路强,只能靠「哪些条目只被
 * BM25 命中、哪些只被向量命中」来判断。没有这一栏,权重与阈值全是盲调。
 */

function scoreText(n: number): string {
  if (!Number.isFinite(n)) return '-';
  return Math.abs(n) >= 0.01 ? n.toFixed(3) : n.toExponential(2);
}

/** 融合栏的来源标签:双路命中的条目才是混合检索真正赚到的部分。 */
function sourceTag(hit: StageHit): { text: string; cls: string } | null {
  if (!hit.ranks) return null;
  const inBm25 = 'bm25' in hit.ranks;
  const inVector = 'vector' in hit.ranks;
  if (inBm25 && inVector) return { text: '双路', cls: 'is-both' };
  if (inBm25) return { text: '仅 BM25', cls: 'is-bm25' };
  if (inVector) return { text: '仅向量', cls: 'is-vector' };
  return null;
}

function Column(props: { title: string; hits: StageHit[]; empty: string }) {
  return (
    <div class="srdb-col">
      <div class="srdb-col__head">
        {props.title}
        <span class="srdb-col__count">{props.hits.length}</span>
      </div>
      <div class="srdb-col__body">
        {!props.hits.length && <p class="srdb-placeholder">{props.empty}</p>}
        {props.hits.map((h, i) => {
          const tag = sourceTag(h);
          return (
            <div class="srdb-hit" key={`${h.ref}-${i}`}>
              <div class="srdb-hit__top">
                <span class="srdb-hit__rank">#{i + 1}</span>
                <span class="srdb-hit__score">{scoreText(h.score)}</span>
                {tag && <span class={`srdb-tag ${tag.cls}`}>{tag.text}</span>}
              </div>
              <div class="srdb-hit__title">{h.title || `${h.kbName} #${h.ordinal}`}</div>
              {h.preview && <div class="srdb-hit__preview">{h.preview}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Snapshot({ snap, source }: { snap: DebugSnapshot; source: 'manual' | 'recall' }) {
  const timings = Object.entries(snap.timings);
  return (
    <>
      <div class="srdb-meta">
        <div>
          <strong>来源</strong>:
          {source === 'recall'
            ? '上次真实召回(查询由参数指定的最近聊天消息拼接)'
            : '调试台手动检索(使用输入框内容)'}
        </div>
        <div>
          <strong>查询</strong>:{snap.query || '(空)'}
        </div>
        <div>
          <strong>分词</strong>:
          {snap.terms.length ? snap.terms.map(t => <code class="srdb-term" key={t}>{t}</code>) : '(空)'}
        </div>
        {timings.length > 0 && (
          <div>
            <strong>耗时</strong>:
            {timings.map(([k, v]) => (
              <code class="srdb-term" key={k}>
                {k} {v.toFixed(0)}ms
              </code>
            ))}
          </div>
        )}
      </div>

      {snap.notes.map(n => (
        <p class="srdb-testresult is-info" key={n}>
          {n}
        </p>
      ))}

      <div class="srdb-cols">
        <Column title="BM25" hits={snap.stages.bm25} empty="无命中" />
        <Column
          title="向量"
          hits={snap.stages.vector}
          empty={snap.degraded.embed ? 'Embedding 不可用' : '无命中'}
        />
        <Column title="融合" hits={snap.stages.fused} empty="无候选" />
        <Column
          title="Rerank"
          hits={snap.stages.reranked}
          empty={snap.degraded.rerank ? 'Rerank 不可用,已用融合序' : '无过阈值条目'}
        />
      </div>
    </>
  );
}

export function DebugConsole() {
  const query = useSignal('');
  const running = useSignal(false);
  const error = useSignal('');
  const snap = useSignal<DebugSnapshot | null>(null);
  const source = useSignal<'manual' | 'recall'>('manual');

  const s = settings.value;
  const activeKbs = s.kbs.filter(k => k.enabled).map(k => ({ id: k.id, name: k.name }));

  const run = async () => {
    running.value = true;
    error.value = '';
    try {
      const outcome = await retrieve(query.value, {
        params: {
          bm25TopN: s.retrieval.bm25TopN,
          vectorTopN: s.retrieval.vectorTopN,
          fuseTopN: s.retrieval.fuseTopN,
          rerankTopK: s.retrieval.rerankTopK,
          rrfK: s.retrieval.rrfK,
          fusionMode: s.retrieval.fusionMode,
          weights: s.retrieval.weights,
          bm25: s.retrieval.bm25,
          rerankThreshold: s.retrieval.rerankThreshold,
          fuseThreshold: s.retrieval.fuseThreshold,
          charBudget: s.injection.charBudget,
        },
        embedCfg: s.embedding,
        rerankCfg: s.rerank,
        kbs: activeKbs,
        debug: true,
      });
      snap.value = outcome.debug;
      source.value = 'manual';
    } catch (e) {
      error.value = describeError(e);
    } finally {
      running.value = false;
    }
  };

  const fillFromChat = () => {
    const ctx = getContext();
    query.value = buildQuery(ctx?.chat ?? [], s.retrieval.queryMessageCount);
  };

  return (
    <div>
      <Section
        title="检索调试台"
        note="这里只跑检索，不会写入注入槽，也不影响正在进行的对话。"
      >
        <textarea
          class="srdb-textarea"
          rows={3}
          placeholder="输入一句样例文本查询"
          value={query.value}
          onInput={e => (query.value = (e.target as HTMLTextAreaElement).value)}
        />
        <div class="srdb-row srdb-row--end">
          <Button onClick={fillFromChat}>取当前对话</Button>
          <Button
            onClick={() => {
              if (lastDebug.value) {
                snap.value = lastDebug.value;
                source.value = 'recall';
              }
            }}
            disabled={!lastDebug.value}
          >
            看上次真实召回
          </Button>
          <Button variant="primary" disabled={running.value || !activeKbs.length} onClick={run}>
            {running.value ? '检索中…' : '跑一次'}
          </Button>
        </div>

        {!activeKbs.length && <p class="srdb-testresult is-info">没有已启用的知识库。</p>}
        {error.value && <p class="srdb-testresult is-bad">{error.value}</p>}
      </Section>

      {snap.value && <Snapshot snap={snap.value} source={source.value} />}
    </div>
  );
}
