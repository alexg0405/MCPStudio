import type { ReactNode } from 'react';
import styles from './CleanupWindow.module.css';

/** A section of the window: a switch in its title, a plain sentence under it and its controls. */
export function Section({
  title,
  isOn,
  onToggle,
  hint,
  intro,
  children,
}: {
  title: string;
  isOn: boolean;
  onToggle: (on: boolean) => void;
  hint: string;
  intro: string;
  children?: ReactNode;
}) {
  return (
    <section className={`${styles.section} ${isOn ? styles.sectionOn : ''}`}>
      <label className={styles.sectionTitle} data-hint={hint}>
        <input type="checkbox" checked={isOn} onChange={(e) => onToggle(e.target.checked)} />
        {title}
      </label>
      <p className={styles.intro}>{intro}</p>
      {isOn ? <div className={styles.controls}>{children}</div> : null}
    </section>
  );
}

/** A labelled slider with its value in words, for one setting of a section. */
export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  text,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** The value as shown, with its unit ("12 dB", "50 %", "Remove"). */
  text: string;
  hint: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.row} data-hint={hint}>
      <span className={styles.rowLabel}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className={styles.value}>{text}</span>
    </label>
  );
}

/** A small button of the window. */
export function ToolButton({
  label,
  hint,
  onClick,
  isOn,
  isDisabled,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  isOn?: boolean;
  isDisabled?: boolean;
}) {
  return (
    <button type="button" className={`${styles.tool} ${isOn ? styles.toolOn : ''}`} disabled={isDisabled} aria-pressed={isOn} onClick={onClick} data-hint={hint}>
      {label}
    </button>
  );
}
