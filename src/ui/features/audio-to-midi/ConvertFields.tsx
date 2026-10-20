import type { ReactNode } from 'react';
import styles from './ConvertDialog.module.css';

/** A labelled slider with its value shown in its unit; the hint says what it does in plain words. */
export function SliderField(props: { label: string; unit: string; value: number; min: number; max: number; step?: number; hint: string; onChange(value: number): void }) {
  return (
    <label className={styles.cell} data-hint={props.hint}>
      <span>
        {props.label}: {props.value}
        {props.unit}
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} aria-label={`${props.label} in ${props.unit.trim() || 'steps'}`} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}

/** A labelled drop-down list. */
export function SelectField(props: { label: string; value: string; hint: string; options: readonly { value: string; label: string; hint?: string }[]; onChange(value: string): void; extra?: ReactNode }) {
  return (
    <label className={styles.cell} data-hint={props.hint}>
      <span>{props.label}</span>
      <select value={props.value} aria-label={props.label} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value} title={o.hint}>
            {o.label}
          </option>
        ))}
      </select>
      {props.extra}
    </label>
  );
}

/** A check box with its label. */
export function CheckField(props: { label: string; checked: boolean; hint: string; disabled?: boolean; onChange(checked: boolean): void }) {
  return (
    <label className={styles.check} data-hint={props.hint}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled === true} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}
