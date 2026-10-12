// Public UI controls for plugin editors: `import { Knob, Toggle, Select } from '@agstudio/sdk/ui'`.
import type { ParamValue, EnumSpec, BoolSpec } from '../params';
import styles from './controls.module.css';

export { Knob, type KnobProps } from './Knob';
export { emitHint, HINT_EVENT } from './hint';

export function Toggle({
  spec,
  value,
  label,
  onCommit,
}: {
  spec: BoolSpec;
  value: boolean;
  label?: string;
  onCommit(value: ParamValue): void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`${styles.toggle} ${value ? styles.toggleOn : ''}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => onCommit(!value)}
      data-hint={`${label ?? spec.label ?? ''}: ${value ? 'On' : 'Off'}`}
    >
      <i className={styles.led} />
      {label ?? spec.label}
    </button>
  );
}

export function Select({
  spec,
  value,
  label,
  onCommit,
}: {
  spec: EnumSpec;
  value: string;
  label?: string;
  onCommit(value: ParamValue): void;
}) {
  const labels = spec.labels as Record<string, string | undefined> | undefined;
  return (
    <select
      className={styles.select}
      value={value}
      onChange={(e) => onCommit(e.target.value)}
      data-hint={label ?? spec.label}
      aria-label={label ?? spec.label}
    >
      {spec.options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  );
}
