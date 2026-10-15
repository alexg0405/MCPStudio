import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { formatChord } from '@core/commands/keymap';
import { useServices, useSession } from '../services-context';
import { useCommandState } from './command-state';
import { Icon, type IconName } from '../controls/Icon';
import { MenuBar } from './MenuBar';
import { getToolbarSlots, subscribeToolbar } from './toolbar-slots';
import styles from './Shell.module.css';


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

function useToolbarSlots(area: 'transport' | 'center' | 'right') {
  const [, force] = useState(0);
  useEffect(() => subscribeToolbar(() => force((n) => n + 1)), []);
  return getToolbarSlots(area);
}

function ToolbarSlots({ area }: { area: 'transport' | 'right' }) {
  return (
    <>
      {useToolbarSlots(area).map((slot) => (
        <slot.component key={slot.id} />
      ))}
    </>
  );
}

const MORE_BUTTON_W = 34;
const SLOT_GAP = 4;

/**
 * The center slots take whatever width is left. Slots that do not fit move, from the end, into a "More"
 * dropdown instead of being clipped (never the first one). Widths are measured while a slot is in the bar and remembered.
 */
function OverflowSlots() {
  const slots = useToolbarSlots('center');
  const groupRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  // How many slots fit, for the slot list it was measured with; a new list shows everything once to measure it.
  const [measured, setMeasured] = useState({ ids: '', fit: 0 });
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<CSSProperties>({});
  const ids = slots.map((s) => s.id).join(',');
  const fit = measured.ids === ids ? measured.fit : Infinity;

  const layout = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    for (const el of group.querySelectorAll<HTMLElement>('[data-slot]')) {
      widths.current.set(el.dataset.slot!, el.offsetWidth);
    }
    const style = getComputedStyle(group);
    const avail = group.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const list = getToolbarSlots('center');
    const total = (n: number) =>
      list.slice(0, n).reduce((sum, s) => {
        const w = widths.current.get(s.id) ?? 0;
        return w ? sum + w + SLOT_GAP : sum;
      }, 0);
    // The first slot (the AI studio button) never moves into "More": it is the last thing to collapse,
    // and the group stays wide enough to show it next to the "More" button.
    const first = list[0] ? (widths.current.get(list[0].id) ?? 0) : 0;
    const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    group.style.minWidth = first ? `${Math.ceil(first + SLOT_GAP + MORE_BUTTON_W + pad)}px` : '';
    let n = list.length;
    if (total(n) > avail + SLOT_GAP) {
      while (n > 1 && total(n) + MORE_BUTTON_W > avail) n--;
    }
    setMeasured({ ids: list.map((s) => s.id).join(','), fit: n });
    if (n === list.length) setOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (fit === Infinity) layout();
  }, [fit, layout]);
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const ro = new ResizeObserver(() => layout());
    ro.observe(group);
    ro.observe(group.parentElement!);
    return () => ro.disconnect();
  }, [layout]);

  const hidden = slots.slice(fit);
  const showPanel = open && hidden.length > 0;

  const toggle = () => {
    const r = moreRef.current!.getBoundingClientRect();
    setPanelPos({ top: r.bottom + 4, right: Math.max(4, window.innerWidth - r.right) });
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!showPanel) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || moreRef.current?.contains(t)) return;
      // Menus opened from inside the panel render elsewhere; only close for clicks on the app itself.
      if ((t as Element).closest?.('[role="menu"], [role="listbox"], [role="dialog"]')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [showPanel]);

  return (
    <div ref={groupRef} className={`${styles.toolbarGroup} ${styles.toolbarGroupFill}`}>
      {slots.slice(0, fit).map((slot) => (
        <div key={slot.id} data-slot={slot.id} className={styles.toolbarSlot}>
          <slot.component />
        </div>
      ))}
      {hidden.length > 0 && (
        <button
          ref={moreRef}
          className={`${styles.toolButton} ${showPanel ? styles.toolButtonOn : ''}`}
          tabIndex={-1}
          onPointerDown={(e) => e.preventDefault()}
          onClick={toggle}
          aria-label="More toolbar controls"
          aria-expanded={showPanel}
          data-hint={`More toolbar controls that don't fit this window width (${hidden.length} hidden). Widen the window to show them in the bar.`}
        >
          <Icon name="chevronDown" />
        </button>
      )}
      {showPanel && (
        <div ref={panelRef} className={styles.toolbarOverflow} style={panelPos}>
          {hidden.map((slot) => (
            <div key={slot.id} className={styles.toolbarOverflowItem}>
              <slot.component />
            </div>
          ))}
        </div>
      )}
    </div>
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
      <OverflowSlots />
      <div className={`${styles.toolbarGroup} ${styles.toolbarGroupRight}`} data-tour="windows">
        <ToolbarSlots area="right" />
      </div>
    </header>
  );
}
