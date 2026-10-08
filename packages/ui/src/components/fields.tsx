import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';

export function Field(props: { label: string; hint?: string | undefined; children: ComponentChildren }) {
  return (
    <div class="field">
      <span class="field-label">{props.label}</span>
      <div class="field-body">
        {props.children}
        {props.hint && <div class="hint">{props.hint}</div>}
      </div>
    </div>
  );
}

export function Toggle(props: { label: string; checked: boolean; disabled?: boolean; onChange(checked: boolean): void }) {
  return (
    <label class={`toggle${props.disabled ? ' disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange((e.currentTarget as HTMLInputElement).checked)}
      />
      <span class="track" aria-hidden="true" />
      <span>{props.label}</span>
    </label>
  );
}

export function NumberInput(props: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  label: string;
  disabled?: boolean;
  onChange(value: number): void;
}) {
  return (
    <span class="number">
      <input
        type="number"
        aria-label={props.label}
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        disabled={props.disabled}
        onChange={(e) => {
          const v = Number((e.currentTarget as HTMLInputElement).value);
          if (!Number.isFinite(v)) return;
          const lo = props.min ?? -Infinity;
          const hi = props.max ?? Infinity;
          props.onChange(Math.min(hi, Math.max(lo, v)));
        }}
      />
      {props.suffix && <span class="suffix">{props.suffix}</span>}
    </span>
  );
}

export function Segmented<T extends string>(props: { label: string; value: T; options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>; onChange(v: T): void }) {
  const name = useId();
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <label key={o.value} class={`${o.value === props.value ? 'on' : ''}${o.disabled ? ' disabled' : ''}`}>
          <input type="radio" name={name} value={o.value} checked={o.value === props.value} disabled={o.disabled} onChange={() => props.onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

export function Select<T extends string>(props: { label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; disabled?: boolean; onChange(v: T): void }) {
  return (
    <select aria-label={props.label} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange((e.currentTarget as HTMLSelectElement).value as T)}>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Notice(props: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ComponentChildren }) {
  return (
    <div class={`notice ${props.kind ?? 'info'}`} role={props.kind === 'error' ? 'alert' : 'status'}>
      {props.children}
    </div>
  );
}
