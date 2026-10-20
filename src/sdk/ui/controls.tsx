// Toggle and Select: the SDK's switch and drop-down for plugin editors.
import { useContext, type MouseEvent } from 'react';
import type { ParamValue, EnumSpec, BoolSpec } from '../params';
import { ParamMenuContext } from './param-menu';
import styles from './controls.module.css';

/** Right-click handler that opens the host's param menu for `param` (undefined without one). */
function useParamMenu(param: string | undefined) {
  const open = useContext(ParamMenuContext);
  if (!param || !open) return undefined;
  return (e: MouseEvent) => {
    e.preventDefault();
    open(param, e);
  };
}

interface ToggleProps {
  spec: BoolSpec;
  value: boolean;
  label?: string;
  onCommit(value: ParamValue): void;
  /** The param's id: right-click opens the host's param menu. */
  param?: string;
  /** What it does, added to its hint ("Sync: On — Locks the LFO to the song's tempo"). */
  hint?: string;
}

/** An on/off switch with a lit LED; clicking flips it. */
export function Toggle({ spec, value, label, onCommit, param, hint }: ToggleProps) {
  const onContextMenu = useParamMenu(param);
  const state = `${label ?? spec.label ?? ''}: ${value ? 'On' : 'Off'}`;
  return (
    <button
      type="button"
      onContextMenu={onContextMenu}
      className={`${styles.toggle} ${value ? styles.toggleOn : ''}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => onCommit(!value)}
      data-hint={hint ? `${state} — ${hint}` : state}
    >
      <i className={styles.led} />
      {label ?? spec.label}
    </button>
  );
}

interface SelectProps {
  spec: EnumSpec;
  value: string;
  label?: string;
  onCommit(value: ParamValue): void;
  /** The param's id: right-click opens the host's param menu. */
  param?: string;
  /** What it chooses, added to its hint with the current choice ("Shape: Sine — How the LFO moves"). */
  hint?: string;
}

/** A drop-down listing an enum param's options (by their labels). */
export function Select({ spec, value, label, onCommit, param, hint }: SelectProps) {
  const labels = spec.labels as Record<string, string | undefined> | undefined;
  const onContextMenu = useParamMenu(param);
  const name = label ?? spec.label;
  return (
    <select
      onContextMenu={onContextMenu}
      className={styles.select}
      value={value}
      onChange={(e) => onCommit(e.target.value)}
      data-hint={hint ? `${name ?? ''}: ${labels?.[value] ?? value} — ${hint}` : name}
      aria-label={name}
    >
      {spec.options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  );
}
