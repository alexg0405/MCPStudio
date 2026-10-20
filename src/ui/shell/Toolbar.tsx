import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { formatChord } from '@core/commands/keymap';
import { useServices, useSession } from '../services-context';
import { useCommandState } from './command-state';
import { Icon, type IconName } from '../controls/Icon';
import { MenuBar } from './MenuBar';
import { getToolbarSlots, subscribeToolbar } from './toolbar-slots';
import { keptSlotIds, MORE_BUTTON_W, SLOT_GAP, slotPriority } from './toolbar-overflow';
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

function ToolbarSlots({ area }: { area: 'transport' }) {
  return (
    <>
      {useToolbarSlots(area).map((slot) => (
        <slot.component key={slot.id} />
      ))}
    </>
  );
}

/** While the "More" panel is open, Escape or a click on the app itself (not on a menu opened from inside the panel) closes it. */
function useCloseOnOutsideClick(isOpen: boolean, panelRef: RefObject<HTMLElement | null>, buttonRef: RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      // Menus opened from inside the panel render elsewhere; only close for clicks on the app itself.
      if ((target as Element).closest?.('[role="menu"], [role="listbox"], [role="dialog"]')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
    // `close` only sets state, so it is safe to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, panelRef, buttonRef]);
}

/**
 * Everything right of the transport (the Studio button, pattern picker, meters and the window, undo and audio
 * buttons) takes whatever width is left. Slots that do not fit move into a "More" dropdown instead of being
 * clipped. The Studio button never moves; then the right-hand buttons (windows, undo, audio) stay longest; the
 * rest leave from the end. Widths are measured while a slot is in the bar and remembered.
 */
function OverflowSlots() {
  const center = useToolbarSlots('center');
  const right = useToolbarSlots('right');
  const groupRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  // Which slots fit, for the slot list it was measured with; a new list shows everything once to measure it.
  const [measured, setMeasured] = useState<{ ids: string; shown: ReadonlySet<string> | null }>({
    ids: '',
    shown: null,
  });
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState<CSSProperties>({});
  const ids = [...center, ...right].map((s) => s.id).join(',');
  const shown = measured.ids === ids ? measured.shown : null;

  const layout = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    for (const el of group.querySelectorAll<HTMLElement>('[data-slot]')) {
      widths.current.set(el.dataset.slot!, el.offsetWidth);
    }
    const style = getComputedStyle(group);
    const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const avail = group.clientWidth - pad;
    const c = getToolbarSlots('center');
    const r = getToolbarSlots('right');
    const width = (id: string) => widths.current.get(id) ?? 0;
    const priority = slotPriority(c, r);
    const first = c[0] ? width(c[0].id) : 0;
    // The group stays wide enough to show the Studio button next to the "More" button.
    group.style.minWidth = first ? `${Math.ceil(first + SLOT_GAP + MORE_BUTTON_W + pad)}px` : '';
    const keep = keptSlotIds(priority, width, avail);
    const ids = [...c, ...r].map((x) => x.id).join(',');
    // Same answer as before: no re-render (a slot resizing would otherwise loop through the observer below).
    setMeasured((was) =>
      was.ids === ids && was.shown && was.shown.size === keep.size && [...keep].every((id) => was.shown!.has(id))
        ? was
        : { ids, shown: keep },
    );
    if (keep.size === priority.length) setOpen(false);
  }, []);

  useLayoutEffect(() => {
    if (!shown) layout();
  }, [shown, layout]);
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const ro = new ResizeObserver(() => layout());
    observer.current = ro;
    ro.observe(group);
    ro.observe(group.parentElement!);
    return () => {
      ro.disconnect();
      observer.current = null;
    };
  }, [layout]);
  // A slot that changes width (the audio chip goes away, the sample-rate readout appears) changes what fits.
  useEffect(() => {
    const ro = observer.current;
    const els = [...(groupRef.current?.querySelectorAll('[data-slot]') ?? [])];
    for (const el of els) ro?.observe(el);
    return () => {
      for (const el of els) ro?.unobserve(el);
    };
  });

  const visible = (slot: { id: string }) => !shown || shown.has(slot.id);
  const hidden = [...center, ...right].filter((slot) => !visible(slot));
  const showPanel = open && hidden.length > 0;
  const rightShown = right.filter(visible);

  const toggle = () => {
    const rect = moreRef.current!.getBoundingClientRect();
    setPanelPos({ top: rect.bottom + 4, right: Math.max(4, window.innerWidth - rect.right) });
    setOpen((o) => !o);
  };

  useCloseOnOutsideClick(showPanel, panelRef, moreRef, () => setOpen(false));

  return (
    <div ref={groupRef} className={`${styles.toolbarGroup} ${styles.toolbarGroupFill}`}>
      {center.filter(visible).map((slot) => (
        <div key={slot.id} data-slot={slot.id} className={styles.toolbarSlot}>
          <slot.component />
        </div>
      ))}
      {hidden.length > 0 && (
        <button
          ref={moreRef}
          className={`${styles.toolButton} ${showPanel ? styles.toolButtonOn : ''}`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={toggle}
          aria-label="More toolbar controls"
          aria-expanded={showPanel}
          data-hint={`More toolbar controls that don't fit this window width (${hidden.length} hidden). Widen the window to show them in the bar.`}
        >
          <Icon name="chevronDown" />
        </button>
      )}
      {rightShown.length > 0 && (
        <div className={styles.toolbarRight} data-tour="windows">
          {rightShown.map((slot) => (
            <div key={slot.id} data-slot={slot.id} className={styles.toolbarSlot}>
              <slot.component />
            </div>
          ))}
        </div>
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
    </header>
  );
}
