// Controls bound to a plugin's params through its editor props: one line per control in a custom UI.
import type { ReactNode } from 'react';
import { formatValue, type EnumSpec, type ParamSpec, type ParamSpecs, type ParamValue } from '../params';
import type { PluginUIProps } from '../types';
import { Knob } from './Knob';
import { Select, Toggle } from './controls';
import styles from './controls.module.css';

/** The editor props a control is bound to (any plugin state type). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EditorProps<P extends ParamSpecs> = PluginUIProps<P, any>;

/** A pan value (−1…1) as "C", "L 40%" or "R 25%" (pass it as a knob's `format`). */
export function formatPan(value: ParamValue): string {
  const x = Number(value);
  if (Math.abs(x) < 0.005) return 'C';
  return `${x < 0 ? 'L' : 'R'} ${Math.round(Math.abs(x) * 100)}%`;
}

interface Common<P extends ParamSpecs> {
  /** The editor's props (what your `ui` component receives). */
  ui: EditorProps<P>;
  param: keyof P & string;
  /** Shown with the control; defaults to the param's label. */
  label?: string;
  /** Replaces the param's own hint. */
  hint?: string;
}

/**
 * A knob for one param, with its label and current value underneath. Dragging is one undo step,
 * right-click opens the host's param menu, and the hint says the value and what the knob does.
 */
export function ParamKnob<P extends ParamSpecs>({
  ui,
  param,
  label,
  hint,
  size = 32,
  bipolar,
  format,
  color,
  disabled,
}: Common<P> & {
  size?: number;
  /** Draw from the centre (defaults to true for ranges around 0, like pan and detune). */
  bipolar?: boolean;
  /** Text for a value (under the knob and in the hint bar); defaults to the param's units. */
  format?(value: ParamValue): string;
  color?: string;
  disabled?: boolean;
}) {
  const spec = ui.specs[param] as ParamSpec;
  const value = ui.values[param] as ParamValue;
  const text = label ?? spec.label ?? param;
  const show = format ?? ((v: ParamValue) => formatValue(spec, v));
  const centred = spec.type === 'float' || spec.type === 'int' ? spec.min < 0 && spec.max > 0 : false;
  return (
    <div className={`${styles.paramControl} ${disabled ? styles.disabled : ''}`}>
      <Knob
        spec={spec}
        value={value}
        label={text}
        size={size}
        param={param}
        hint={hint ?? spec.hint}
        bipolar={bipolar ?? centred}
        format={show}
        color={color}
        disabled={disabled}
        onBegin={() => ui.beginEdit(param)}
        onChange={(v) => ui.setParam(param, v)}
        onEnd={() => ui.endEdit(param)}
        onCommit={(v) => ui.setParam(param, v)}
      />
      <span className={styles.paramLabel}>{text}</span>
      <span className={styles.paramValue}>{show(value)}</span>
    </div>
  );
}

/** An on/off switch for a bool param. */
export function ParamToggle<P extends ParamSpecs>({ ui, param, label, hint }: Common<P>) {
  const spec = ui.specs[param] as ParamSpec;
  if (spec.type !== 'bool') return null;
  return (
    <Toggle
      spec={spec}
      value={Boolean(ui.values[param])}
      label={label ?? spec.label ?? param}
      param={param}
      hint={hint ?? spec.hint}
      onCommit={(v) => ui.setParam(param, v)}
    />
  );
}

/** A drop-down for an enum param, with its label above it. */
export function ParamSelect<P extends ParamSpecs>({
  ui,
  param,
  label,
  hint,
  inline,
}: Common<P> & { inline?: boolean }) {
  const spec = ui.specs[param] as EnumSpec;
  if (spec.type !== 'enum') return null;
  const text = label ?? spec.label ?? param;
  return (
    <label className={inline ? styles.paramSelectInline : styles.paramSelect}>
      <span className={styles.paramLabel}>{text}</span>
      <Select
        spec={spec}
        value={String(ui.values[param])}
        label={text}
        param={param}
        hint={hint ?? spec.hint}
        onCommit={(v) => ui.setParam(param, v)}
      />
    </label>
  );
}

/** A titled box of controls, like the sections of the generated editor. Its hint covers empty space in it. */
export function Section({
  title,
  hint,
  children,
  wide,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  /** Takes the whole row. */
  wide?: boolean;
}) {
  return (
    <section className={`${styles.section} ${wide ? styles.sectionWide : ''}`} data-hint={hint}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}
