import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { formatChord } from '@core/commands/keymap';
import { useServices, useSession } from '../services-context';
import { Icon, type IconName } from '../controls/Icon';
import { MenuBar } from './MenuBar';
import { getToolbarSlots, subscribeToolbar } from './toolbar-slots';
import styles from './Shell.module.css';

/** A command's enabled/checked state; re-renders only when it actually changes. */
export function useCommandState(id: string) {
  const services = useServices();
  const subscribe = useCallback((fn: () => void) => services.subscribe(fn), [services]);
  const snap = useSyncExternalStore(
    subscribe,
    () => `${services.commands.isEnabled(id) ? 1 : 0}${services.commands.isChecked(id) ? 1 : 0}`,
  );
  return { enabled: snap[0] === '1', checked: snap[1] === '1' };
}

/** A toolbar button bound to a command. Never takes focus, so Space keeps meaning play/stop. */
export function CommandButton({
  command,
  icon,
  label,
  args,
  className,
  tour,
  children,
}: {
  command: string;
  icon?: IconName;
  label?: string;
  args?: unknown;
  className?: string;
  /** Anchor for the guided tour (`data-tour`). */
  tour?: string;
  children?: ReactNode;
}) {
  const services = useServices();
  const { enabled, checked } = useCommandState(command);
  const def = services.commands.get(command);
  const chord = services.keymap.chordsFor(command)[0];
  const title = def?.title ?? command;
  const hint = `${def?.hint ?? title}${chord ? `  (${formatChord(chord, services.platform)})` : ''}`;
  return (
    <button
      className={`${styles.toolButton} ${checked ? styles.toolButtonOn : ''} ${className ?? ''}`}
      disabled={!enabled}
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => services.commands.run(command, args)}
      data-hint={hint}
      aria-label={title}
      aria-pressed={def?.checked ? checked : undefined}
      data-tour={tour}
    >
      {icon && <Icon name={icon} />}
      {label && <span>{label}</span>}
      {children}
    </button>
  );
}

function HintBar() {
  const services = useServices();
  const hint = useSession((s) => s.hint);
  const chord = services.keymap.chordsFor('help.palette')[0];
  return (
    <div className={styles.hintBar} title={hint} data-tour="hints">
      {hint || (
        <span className={styles.hintIdle}>
          Point at anything to see what it does
          {chord && (
            <>
              {' · '}
              <kbd>{formatChord(chord, services.platform)}</kbd> finds any action
            </>
          )}
        </span>
      )}
    </div>
  );
}

function ToolbarSlots({ area }: { area: 'transport' | 'center' | 'right' }) {
  const [, force] = useState(0);
  useEffect(() => subscribeToolbar(() => force((n) => n + 1)), []);
  return (
    <>
      {getToolbarSlots(area).map((slot) => (
        <slot.component key={slot.id} />
      ))}
    </>
  );
}

export function Toolbar() {
  return (
    <header className={styles.toolbar}>
      <div className={styles.brandBlock}>
        <div className={styles.brandRow}>
          <span className={styles.brand} data-hint="AGstudio">
            AG<b>studio</b>
          </span>
          <MenuBar />
        </div>
        <HintBar />
      </div>
      <div className={styles.toolbarGroup} data-tour="transport">
        <ToolbarSlots area="transport" />
      </div>
      <div className={`${styles.toolbarGroup} ${styles.toolbarGroupShrink}`}>
        <ToolbarSlots area="center" />
      </div>
      <div className={styles.toolbarSpacer} />
      <div className={styles.toolbarGroup} data-tour="windows">
        <ToolbarSlots area="right" />
      </div>
    </header>
  );
}
