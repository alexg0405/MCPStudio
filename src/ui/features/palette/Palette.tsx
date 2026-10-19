import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createStore, useStore } from 'zustand';
import { holdModal } from '../../controls/Dialog';
import type { ActionEntry } from '../../shell/actions';
import { useServices } from '../../services-context';
import { collectActions } from './collect';
import { paletteRows } from './palette-rows';
import { pushRecent } from './search';
import { Icon } from '../../controls/Icon';
import { isTouchLayout } from '../../touch/layout';
import styles from './Palette.module.css';

/** Open/closed, outside React so the command and the overlay share it. */
export const paletteStore = createStore<{ open: boolean; query: string }>(() => ({ open: false, query: '' }));

/** Opens the action search (with `query` typed in), or closes it when it is open. */
export function togglePalette(query = ''): void {
  const open = !paletteStore.getState().open;
  paletteStore.setState({ open, query: open ? query : '' });
}

/** Row height in px (the CSS fixes it), and the list's padding: only the rows near the viewport are in the DOM. */
const ROW_H = 32;
/** In the touch layout the rows are this tall (px; the CSS says so too): a fingertip needs more than a mouse pointer. */
const TOUCH_ROW_H = 40;
/** The height of a row now. */
const rowHeight = (): number => (isTouchLayout() ? TOUCH_ROW_H : ROW_H);
const LIST_PAD = 6;
/** Rows drawn below the first visible one: the list is at most ~560 px tall, so this always covers it. */
const WINDOW_ROWS = 20;
const OVERSCAN = 3;

/** One action: a check (or the Studio mark), its label, where it is in the menus and its shortcut. */
const Row = memo(function Row({ entry, index, isActive, hover, run }: { entry: ActionEntry; index: number; isActive: boolean; hover(i: number): void; run(e: ActionEntry): void }) {
  const isAi = entry.key === 'ai';
  return (
    <div
      id={`ag-palette-${index}`}
      data-index={index}
      role="option"
      aria-selected={isActive}
      aria-disabled={entry.disabled || undefined}
      className={`${styles.row} ${isActive ? styles.rowActive : ''} ${entry.disabled ? styles.rowDisabled : ''} ${isAi ? styles.rowAi : ''}`}
      onPointerMove={() => !isActive && hover(index)}
      onClick={() => run(entry)}
    >
      <span className={styles.check}>{isAi ? <Icon name="studio" size={13} /> : entry.checked ? '✓' : ''}</span>
      <span className={styles.label}>{entry.label}</span>
      <span className={styles.path}>{entry.path.join(' › ')}</span>
      {entry.chord && <kbd className={styles.chord}>{entry.chord}</kbd>}
    </div>
  );
});

/** Overlay host: renders the search while the palette command has it open. */
export function PaletteOverlay() {
  const open = useStore(paletteStore, (s) => s.open);
  return open ? <Palette /> : null;
}

/** Keeps the active row in view by arithmetic (rows outside the window are not in the DOM to scroll to). */
function useActiveRowInView(listRef: RefObject<HTMLDivElement | null>, active: number): void {
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const rowH = rowHeight();
    const top = LIST_PAD + active * rowH;
    if (top < list.scrollTop) list.scrollTop = top - LIST_PAD;
    else if (top + rowH + LIST_PAD > list.scrollTop + list.clientHeight) list.scrollTop = top + rowH + LIST_PAD - list.clientHeight;
  }, [listRef, active]);
}

/** While the search is open it has the keyboard and gives it back to what had the focus when it closes. */
function useHoldKeyboard(inputRef: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const release = holdModal();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      release();
      if (previous?.isConnected) previous.focus();
    };
  }, [inputRef]);
}

/** The action search: type to find any menu entry or command, Enter runs it, and anything else can be asked of Studio. */
function Palette() {
  const services = useServices();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(() => paletteStore.getState().query);
  const [active, setActive] = useState(0);
  // First row in the window: follows the list's scroll (the list can hold 80 rows; ~12 show).
  const [scrollRow, setScrollRow] = useState(0);
  // Gathered once per opening: menus and enabled states as they are right now.
  const entries = useMemo(() => collectActions(services), [services]);
  const recent = useMemo(() => services.prefs.getState().recentActions, [services]);
  const rows = useMemo(() => paletteRows(services, entries, query, recent), [entries, query, recent, services]);

  const close = () => paletteStore.setState({ open: false, query: '' });
  const runRef = useRef<(e: ActionEntry | undefined) => void>(() => {});
  const runStable = useCallback((e: ActionEntry) => runRef.current(e), []);
  const run = (e: ActionEntry | undefined) => {
    if (!e || e.disabled) return;
    close();
    if (e.key !== 'ai') services.prefs.getState().set({ recentActions: pushRecent(services.prefs.getState().recentActions, e.key) });
    try {
      e.run();
    } catch (err) {
      services.session.getState().toast(`${e.label}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };
  useLayoutEffect(() => {
    runRef.current = run;
  });
  useHoldKeyboard(inputRef);
  useActiveRowInView(listRef, active);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const count = rows.length;
      if (count) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : count - 1)) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(rows[active]);
    } else if (e.key === 'Escape' || (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      close();
    }
    // Typing here never plays the typing piano or triggers shortcuts.
    e.stopPropagation();
  };

  const current = rows[active];
  // The window always holds the active row (the input's aria-activedescendant points at it).
  const from = Math.max(0, Math.min(scrollRow, active) - OVERSCAN);
  const to = Math.min(rows.length, Math.max(scrollRow + WINDOW_ROWS, active + 1 + OVERSCAN));
  return (
    <div className={styles.backdrop} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className={styles.panel} role="dialog" aria-label="Search actions">
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          placeholder="What do you want to do? (e.g. “metronome”, “add reverb”, “export”)"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          aria-controls="ag-palette-list"
          aria-activedescendant={current ? `ag-palette-${active}` : undefined}
        />
        <div
          ref={listRef}
          id="ag-palette-list"
          className={styles.list}
          role="listbox"
          onScroll={(ev) => {
            const first = Math.max(0, Math.floor((ev.currentTarget.scrollTop - LIST_PAD) / rowHeight()));
            if (first !== scrollRow) setScrollRow(first);
          }}
        >
          {rows.length === 0 && <div className={styles.empty}>Type to search every menu and command.</div>}
          <div style={{ paddingTop: from * rowHeight(), paddingBottom: (rows.length - to) * rowHeight() }}>
            {rows.slice(from, to).map((e, k) => (
              <Row key={e.key} entry={e} index={from + k} isActive={from + k === active} hover={setActive} run={runStable} />
            ))}
          </div>
        </div>
        <PaletteFooter current={current} />
      </div>
    </div>
  );
}

/** The line under the list: what the chosen action does, and the keys. */
function PaletteFooter({ current }: { current: ActionEntry | undefined }) {
  return (
    <div className={styles.footer}>
      <span className={styles.footerHint}>
        {current?.disabled ? 'Not available right now. ' : ''}
        {current?.hint ?? (current ? current.label : '')}
      </span>
      <span className={styles.keys}>
        <kbd>↑</kbd>
        <kbd>↓</kbd> choose <kbd>Enter</kbd> run <kbd>Esc</kbd> close
      </span>
    </div>
  );
}
