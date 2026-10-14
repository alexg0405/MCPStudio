// Public UI controls for plugin editors: `import { Knob, Toggle, Select } from '@agstudio/sdk/ui'`.
import { useContext, type MouseEvent } from 'react';
import type { ParamValue, EnumSpec, BoolSpec } from '../params';
import { ParamMenuContext } from './param-menu';
import styles from './controls.module.css';

export { Knob, type KnobProps } from './Knob';
export { emitHint, HINT_EVENT } from './hint';
export {
  ParamFollowContext,
  ParamMenuContext,
  ParamStatusContext,
  useParamStatus,
  type ParamStatus,
} from './param-menu';

/** Right-click handler that opens the host's param menu for `param` (undefined without one). */
function useParamMenu(param: string | undefined) {
  const open = useContext(ParamMenuContext);
  if (!param || !open) return undefined;
  return (e: MouseEvent) => {
    e.preventDefault();
    open(param, e);
  };
}

export function Toggle({
  spec,
  value,
  label,
  onCommit,
  param,
}: {
  spec: BoolSpec;
  value: boolean;
  label?: string;
  onCommit(value: ParamValue): void;
  /** The param's id: right-click opens the host's param menu. */
  param?: string;
}) {
  const onContextMenu = useParamMenu(param);
  return (
    <button
      type="button"
      tabIndex={-1}
      onContextMenu={onContextMenu}
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
  param,
}: {
  spec: EnumSpec;
  value: string;
  label?: string;
  onCommit(value: ParamValue): void;
  /** The param's id: right-click opens the host's param menu. */
  param?: string;
}) {
  const labels = spec.labels as Record<string, string | undefined> | undefined;
  const onContextMenu = useParamMenu(param);
  return (
    <select
      onContextMenu={onContextMenu}
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
