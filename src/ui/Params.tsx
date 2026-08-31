import { settings, updateSettings } from '@/settings';
import { Field, NumberInput, Section, Toggle } from './controls';

export function Params() {
  const s = settings.value;
  const r = s.retrieval;

  return (
    <div>
      <Section title="总开关">
        <Toggle
          checked={s.enabled}
          label="生成前自动检索并注入"
          onToggle={v => updateSettings(d => void (d.enabled = v))}
        />
      </Section>

      <Section title="查询" note="从最近若干条消息拼出检索用的 query。">
        <Field label="取最近几条消息">
          <NumberInput
            min={1}
            max={20}
            value={r.queryMessageCount}
            onCommit={v => updateSettings(d => void (d.retrieval.queryMessageCount = v))}
          />
        </Field>
      </Section>

      <Section title="召回" note="两路并行,各取 topN 后送入融合。">
        <div class="srdb-row">
          <Field label="BM25 topN">
            <NumberInput min={1} max={1000} value={r.bm25TopN} onCommit={v => updateSettings(d => void (d.retrieval.bm25TopN = v))} />
          </Field>
          <Field label="向量 topN">
            <NumberInput min={1} max={1000} value={r.vectorTopN} onCommit={v => updateSettings(d => void (d.retrieval.vectorTopN = v))} />
          </Field>
        </div>
        <div class="srdb-row">
          <Field label="BM25 k1" hint="词频饱和速度">
            <NumberInput step={0.1} min={0} max={5} value={r.bm25.k1} onCommit={v => updateSettings(d => void (d.retrieval.bm25.k1 = v))} />
          </Field>
          <Field label="BM25 b" hint="文档长度归一强度">
            <NumberInput step={0.05} min={0} max={1} value={r.bm25.b} onCommit={v => updateSettings(d => void (d.retrieval.bm25.b = v))} />
          </Field>
        </div>
      </Section>

      <Section
        title="融合"
        note="默认 RRF:只用排名,不受 BM25 与余弦分数尺度不可比的影响。加权模式仅供对照实验。"
      >
        <Field label="融合方式">
          <select
            class="srdb-input"
            value={r.fusionMode}
            onChange={e =>
              updateSettings(
                d => void (d.retrieval.fusionMode = (e.target as HTMLSelectElement).value as 'rrf' | 'weighted'),
              )
            }
          >
            <option value="rrf">RRF(推荐)</option>
            <option value="weighted">加权归一化(对照)</option>
          </select>
        </Field>

        {r.fusionMode === 'rrf' ? (
          <Field label="RRF 的 k" hint="越大越压平名次差异">
            <NumberInput min={1} max={1000} value={r.rrfK} onCommit={v => updateSettings(d => void (d.retrieval.rrfK = v))} />
          </Field>
        ) : (
          <div class="srdb-row">
            <Field label="BM25 权重">
              <NumberInput step={0.1} min={0} max={10} value={r.weights.bm25} onCommit={v => updateSettings(d => void (d.retrieval.weights.bm25 = v))} />
            </Field>
            <Field label="向量权重">
              <NumberInput step={0.1} min={0} max={10} value={r.weights.vector} onCommit={v => updateSettings(d => void (d.retrieval.weights.vector = v))} />
            </Field>
          </div>
        )}

        <Field label="融合后送入 rerank 的条数">
          <NumberInput min={1} max={200} value={r.fuseTopN} onCommit={v => updateSettings(d => void (d.retrieval.fuseTopN = v))} />
        </Field>
      </Section>

      <Section
        title="精排与阈值"
        note="两套阈值不能共用:rerank 分数与融合分数尺度完全不同,rerank 失败降级时会自动切到融合阈值。"
      >
        <Field label="最终注入条数">
          <NumberInput min={1} max={50} value={r.rerankTopK} onCommit={v => updateSettings(d => void (d.retrieval.rerankTopK = v))} />
        </Field>
        <div class="srdb-row">
          <Field label="Rerank 阈值" hint="rerank 成功时生效">
            <NumberInput step={0.05} min={0} max={1} value={r.rerankThreshold} onCommit={v => updateSettings(d => void (d.retrieval.rerankThreshold = v))} />
          </Field>
          <Field label="融合阈值" hint="rerank 降级时生效,RRF 分数通常远小于 1">
            <NumberInput step={0.001} min={0} max={10} value={r.fuseThreshold} onCommit={v => updateSettings(d => void (d.retrieval.fuseThreshold = v))} />
          </Field>
        </div>
      </Section>

      <Section title="注入">
        <div class="srdb-row">
          <Field label="注入深度" hint="0 = 最靠近末尾">
            <NumberInput min={0} max={10000} value={s.injection.depth} onCommit={v => updateSettings(d => void (d.injection.depth = v))} />
          </Field>
          <Field label="字符预算" hint="超出即停止追加,不截断单条">
            <NumberInput min={100} max={100000} step={100} value={s.injection.charBudget} onCommit={v => updateSettings(d => void (d.injection.charBudget = v))} />
          </Field>
        </div>
      </Section>
    </div>
  );
}
