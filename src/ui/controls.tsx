import type { ComponentChildren } from 'preact';

/**
 * 表单原子件。
 *
 * 数值/文本框一律用 `onChange`(Preact 不像 React 那样把 onChange 重映射到 input 事件,
 * 这里就是原生 change,失焦或回车才触发)。好处是用户中途敲出的临时非法值不会被立刻
 * 归一化回去,不会出现光标乱跳、输入被吞的情况。
 */

export function Field(props: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="srdb-field">
      <span class="srdb-field__label">
        {props.label}
        {props.hint && <span class="srdb-field__hint">{props.hint}</span>}
      </span>
      {props.children}
    </label>
  );
}

export function TextInput(props: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  password?: boolean;
}) {
  return (
    <input
      class="srdb-input"
      type={props.password ? 'password' : 'text'}
      value={props.value}
      placeholder={props.placeholder ?? ''}
      onChange={e => props.onCommit((e.target as HTMLInputElement).value)}
    />
  );
}

export function NumberInput(props: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      class="srdb-input srdb-input--num"
      type="number"
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      onChange={e => {
        const n = Number((e.target as HTMLInputElement).value);
        // 非数字直接忽略这次提交,保留原值 —— 比静默改成 0 安全
        if (Number.isFinite(n)) props.onCommit(n);
      }}
    />
  );
}

export function Toggle(props: { checked: boolean; onToggle: (v: boolean) => void; label?: string }) {
  return (
    <label class="srdb-toggle">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={e => props.onToggle((e.target as HTMLInputElement).checked)}
      />
      {props.label && <span>{props.label}</span>}
    </label>
  );
}

export function Button(props: {
  children: ComponentChildren;
  onClick: () => void;
  variant?: 'primary' | 'danger' | 'plain';
  disabled?: boolean;
}) {
  return (
    <button
      class={`srdb-btn srdb-btn--${props.variant ?? 'plain'}`}
      disabled={props.disabled ?? false}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function Section(props: { title: string; children: ComponentChildren; note?: string }) {
  return (
    <section class="srdb-section">
      <h3 class="srdb-section__title">{props.title}</h3>
      {props.note && <p class="srdb-section__note">{props.note}</p>}
      {props.children}
    </section>
  );
}
