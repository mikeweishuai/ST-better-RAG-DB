import { useSignal } from '@preact/signals';
import { settings, updateSettings } from '@/settings';
import { describeError, type EndpointConfig } from '@/retrieve/http';
import { testEmbedding } from '@/retrieve/embed';
import { testRerank } from '@/retrieve/rerank';
import { Button, Field, NumberInput, Section, TextInput } from './controls';

type TestState = { running: boolean; ok: boolean | null; message: string };

const idle = (): TestState => ({ running: false, ok: null, message: '' });

function EndpointForm(props: {
  title: string;
  note: string;
  cfg: EndpointConfig;
  onPatch: (patch: Partial<EndpointConfig>) => void;
  onTest: (cfg: EndpointConfig) => Promise<string>;
  placeholder: string;
}) {
  const state = useSignal<TestState>(idle());

  const runTest = async () => {
    state.value = { running: true, ok: null, message: '测试中…' };
    try {
      state.value = { running: false, ok: true, message: await props.onTest(props.cfg) };
    } catch (e) {
      state.value = { running: false, ok: false, message: describeError(e) };
    }
  };

  return (
    <Section title={props.title} note={props.note}>
      <Field label="接口地址" hint="填到 /v1 或域名即可;若你的服务路径特殊,可直接填完整地址">
        <TextInput
          value={props.cfg.baseUrl}
          placeholder={props.placeholder}
          onCommit={v => props.onPatch({ baseUrl: v })}
        />
      </Field>
      <Field label="API Key" hint="本地服务可留空">
        <TextInput password value={props.cfg.apiKey} onCommit={v => props.onPatch({ apiKey: v })} />
      </Field>
      <Field label="模型名">
        <TextInput value={props.cfg.model} onCommit={v => props.onPatch({ model: v })} />
      </Field>
      <div class="srdb-row">
        <Field label="超时(秒)">
          <NumberInput min={1} max={600} value={props.cfg.timeoutSec} onCommit={v => props.onPatch({ timeoutSec: v })} />
        </Field>
        <Field label="重试次数">
          <NumberInput min={0} max={5} value={props.cfg.retries} onCommit={v => props.onPatch({ retries: v })} />
        </Field>
      </div>

      <div class="srdb-row srdb-row--end">
        <Button variant="primary" disabled={state.value.running} onClick={runTest}>
          连通性测试
        </Button>
      </div>
      {state.value.message && (
        <p
          class={
            'srdb-testresult ' +
            (state.value.ok === true ? 'is-ok' : state.value.ok === false ? 'is-bad' : '')
          }
        >
          {state.value.message}
        </p>
      )}
    </Section>
  );
}

export function Endpoints() {
  const s = settings.value;

  return (
    <div>
      <EndpointForm
        title="Embedding"
        note="OpenAI 兼容的 /v1/embeddings。留空则只建 BM25 索引,关键词检索照常可用。"
        cfg={s.embedding}
        placeholder="https://api.siliconflow.cn/v1"
        onPatch={patch => updateSettings(d => Object.assign(d.embedding, patch))}
        onTest={async cfg => `连接正常,向量维度 ${(await testEmbedding(cfg)).dim}`}
      />

      <EndpointForm
        title="Rerank"
        note="OpenAI 兼容的 /v1/rerank。未配置或调用失败时自动降级为融合排序。"
        cfg={s.rerank}
        placeholder="https://api.siliconflow.cn/v1"
        onPatch={patch => updateSettings(d => Object.assign(d.rerank, patch))}
        onTest={async cfg =>
          (await testRerank(cfg)).ordered
            ? '连接正常,且相关文档被正确排在前面'
            : '连接正常,但测试样例的排序不符合预期,请确认模型名是否为 rerank 模型'
        }
      />
    </div>
  );
}
