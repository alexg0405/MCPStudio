import { useEffect, useRef, useState } from 'react';
import { createStore, useStore } from 'zustand';
import { formatValue, type ParamSpec, type ParamValue } from '@agstudio/sdk';
import { Knob, Select, Toggle } from '@agstudio/sdk/ui';
import { holdModal } from './Dialog';
import styles from './Dialog.module.css';

/**
 * A modal with fields (tool settings, import options…). Param fields use the SDK controls, so a
 * note script's params get the same knobs as plugins. `onChange` runs on every edit for a live
 * preview; the promise resolves with the values (OK) or null (Cancel / Escape).
 */
export type FormField =
  | { kind: 'param'; key: string; spec: ParamSpec }
  | { kind: 'text'; key: string; label: string; placeholder?: string; multiline?: boolean }
  | { kind: 'choice'; key: string; label: string; options: readonly { value: string; label: string }[] }
  /** A typed number (tempo, bars…): clearer than a knob when the exact value matters. */
  | { kind: 'number'; key: string; label: string; min: number; max: number; step?: number | 'any'; unit?: string }
  | { kind: 'info'; text: string };

export type FormValues = Record<string, ParamValue>;

export interface FormDialogOptions<V extends FormValues> {
  title: string;
  message?: string;
  fields: readonly FormField[];
  values: V;
  onChange?(values: V): void;
  okLabel?: string;
}

interface Open {
  options: FormDialogOptions<FormValues>;
  resolve(values: FormValues | null): void;
}

const formStore = createStore<{ open: Open | null }>(() => ({ open: null }));

export function showFormDialog<V extends FormValues>(options: FormDialogOptions<V>): Promise<V | null> {
  formStore.getState().open?.resolve(null);
  return new Promise((resolve) => {
    formStore.setState({
      open: { options: options as unknown as FormDialogOptions<FormValues>, resolve: resolve as Open['resolve'] },
    });
  });
}

function finish(open: Open, values: FormValues | null): void {
  if (formStore.getState().open === open) formStore.setState({ open: null });
  open.resolve(values);
}

/** Rendered once by the app shell. */
export function FormDialogHost() {
  const open = useStore(formStore, (s) => s.open);
  return open ? <Form key={String(open.options.title)} open={open} /> : null;
}

/** Reports only in-range numbers while typing; leaving the field shows the last good value again. */
function NumberField({
  field,
  value,
  onChange,
}: {
  field: Extract<FormField, { kind: 'number' }>;
  value: number;
  onChange(v: number): void;
}) {
  const [text, setText] = useState(String(value));
  return (
    <input
      type="number"
      className={`${styles.input} ${styles.number}`}
      value={text}
      min={field.min}
      max={field.max}
      step={field.step ?? 1}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= field.min && n <= field.max) onChange(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

function Form({ open }: { open: Open }) {
  const { options } = open;
  const [values, setValues] = useState<FormValues>(options.values);
  const ref = useRef<HTMLDivElement>(null);
  // The values the next OK reports (updated with every edit, so key handlers see them).
  const latest = useRef(values);

  useEffect(() => {
    const release = holdModal();
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(open, null);
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        e.stopPropagation();
        finish(open, latest.current);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      release();
    };
  }, [open]);

  const set = (key: string, v: ParamValue) => {
    const next = { ...latest.current, [key]: v };
    latest.current = next;
    setValues(next);
    options.onChange?.(next);
  };

  return (
    <div className={styles.backdrop}>
      <div ref={ref} tabIndex={-1} className={`${styles.dialog} ${styles.form}`} role="dialog" aria-modal="true">
        <h2 className={styles.title}>{options.title}</h2>
        {options.message && <p className={styles.message}>{options.message}</p>}
        <div className={styles.fields}>
          {options.fields.map((f, i) => {
            if (f.kind === 'info')
              return (
                <p key={i} className={styles.detail}>
                  {f.text}
                </p>
              );
            if (f.kind === 'text')
              return (
                <label key={f.key} className={styles.field}>
                  <span className={styles.fieldLabel}>{f.label}</span>
                  {f.multiline ? (
                    <textarea
                      className={styles.input}
                      rows={4}
                      value={String(values[f.key] ?? '')}
                      placeholder={f.placeholder}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                  ) : (
                    <input
                      className={styles.input}
                      value={String(values[f.key] ?? '')}
                      placeholder={f.placeholder}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                  )}
                </label>
              );
            if (f.kind === 'number')
              return (
                <label key={f.key} className={styles.field}>
                  <span className={styles.fieldLabel}>{f.label}</span>
                  <NumberField field={f} value={Number(values[f.key] ?? f.min)} onChange={(v) => set(f.key, v)} />
                  {f.unit && <span className={styles.fieldValue}>{f.unit}</span>}
                  <span className={styles.fieldRange}>
                    {f.min}–{f.max}
                  </span>
                </label>
              );
            if (f.kind === 'choice')
              return (
                <label key={f.key} className={styles.field}>
                  <span className={styles.fieldLabel}>{f.label}</span>
                  <select
                    className={styles.input}
                    value={String(values[f.key] ?? '')}
                    onChange={(e) => set(f.key, e.target.value)}
                  >
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            const spec = f.spec;
            const value = values[f.key] ?? spec.default;
            const label = spec.label ?? f.key;
            // The param's hint shows in the hint bar and as a tooltip.
            const hint = spec.hint ? { 'data-hint': `${label}: ${spec.hint}`, title: spec.hint } : {};
            if (spec.type === 'bool')
              return (
                <div key={f.key} className={styles.field} {...hint}>
                  <Toggle spec={spec} value={Boolean(value)} label={label} onCommit={(v) => set(f.key, v)} />
                </div>
              );
            if (spec.type === 'enum')
              return (
                <label key={f.key} className={styles.field} {...hint}>
                  <span className={styles.fieldLabel}>{label}</span>
                  <Select spec={spec} value={String(value)} label={label} onCommit={(v) => set(f.key, v)} />
                </label>
              );
            return (
              <div key={f.key} className={styles.field} {...hint}>
                <span className={styles.fieldLabel}>{label}</span>
                <Knob spec={spec} value={value} label={label} size={30} onChange={(v) => set(f.key, v)} />
                <span className={styles.fieldValue}>{formatValue(spec, value)}</span>
              </div>
            );
          })}
        </div>
        <div className={styles.buttons}>
          <button className={styles.button} onClick={() => finish(open, null)}>
            Cancel
          </button>
          <button className={`${styles.button} ${styles.primary}`} onClick={() => finish(open, latest.current)}>
            {options.okLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
