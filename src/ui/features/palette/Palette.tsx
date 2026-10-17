import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createStore, useStore } from 'zustand';
import type { Services } from '@app/services';
import { holdModal } from '../../controls/Dialog';
import type { ActionEntry } from '../../shell/actions';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { collectActions } from './collect';
import { pushRecent, searchActions } from './search';
import { Icon } from '../../controls/Icon';
import styles from './Palette.module.css';

/** Open/closed, outside React so the command and the overlay share it. */
export const paletteStore = createStore<{ open: boolean; query: string }>(() => ({ open: false, query: '' }));

export function togglePalette(query = ''): void {
  const open = !paletteStore.getState().open;
  paletteStore.setState({ open, query: open ? query : '' });
}

const MAX_ROWS = 80;
/** Row height in px (the CSS fixes it), and the list's padding: only the rows near the viewport are in the DOM. */
const ROW_H = 32;
const LIST_PAD = 6;
/** Rows drawn below the first visible one: the list is at most ~560 px tall, so this always covers it. */
const WINDOW_ROWS = 20;
const OVERSCAN = 3;

const Row = memo(function Row({
  entry,
  index,
  isActive,
  hover,
  run,
}: {
  entry: ActionEntry;
  index: number;
  isActive: boolean;
  hover(i: number): void;
  run(e: ActionEntry): void;
}) {
  return (
    <div
      id={`ag-palette-${index}`}
      data-index={index}
      role="option"
      aria-selected={isActive}
      aria-disabled={entry.disabled || undefined}
      className={`${styles.row} ${isActive ? styles.rowActive : ''} ${entry.disabled ? styles.rowDisabled : ''} ${
        entry.key === 'ai' ? styles.rowAi : ''
      }`}
      onPointerMove={() => !isActive && hover(index)}
      onClick={() => run(entry)}
    >
      <span className={styles.check}>
        {entry.key === 'ai' ? <Icon name="studio" size={13} /> : entry.checked ? '✓' : ''}
      </span>
      <span className={styles.label}>{entry.label}</span>
      <span className={styles.path}>{entry.path.join(' › ')}</span>
      {entry.chord && <kbd className={styles.chord}>{entry.chord}</kbd>}
    </div>
  );
});

/** Hands the words to the AI studio: it opens and does it (one undoable change). */
function askAi(s: Services, text: string): void {
  openWindow(s, 'assistant');
  if (s.assistant.store.getState().phase !== 'idle') {
    s.session.getState().toast('Studio is still working on your last request.');
    return;
  }
  void s.assistant.send(text);
}

export function PaletteOverlay() {
  const open = useStore(paletteStore, (s) => s.open);
  return open ? <Palette /> : null;
}

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

  const rows = useMemo(() => {
    const found = searchActions(entries, query, recent).slice(0, MAX_ROWS);
    const text = query.trim();
    if (!text) return found;
    const ai: ActionEntry = {
      key: 'ai',
      label: `Ask Studio: “${text}”`,
      path: ['Studio'],
      hint: 'Claude does it for you in Studio. Every change it makes can be undone.',
      run: () => askAi(services, text),
    };
    // Nothing matches: asking the AI is the best bet, so it comes first.
    return found.length === 0 ? [ai] : [...found, ai];
  }, [entries, query, recent, services]);

  const close = () => paletteStore.setState({ open: false, query: '' });
  const runRef = useRef<(e: ActionEntry | undefined) => void>(() => {});
  const runStable = useCallback((e: ActionEntry) => runRef.current(e), []);
  const run = (e: ActionEntry | undefined) => {
    if (!e || e.disabled) return;
    close();
    if (e.key !== 'ai')
      services.prefs.getState().set({ recentActions: pushRecent(services.prefs.getState().recentActions, e.key) });
    try {
      e.run();
    } catch (err) {
      services.session.getState().toast(`${e.label}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  useEffect(() => {
    const release = holdModal();
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      release();
      if (prev?.isConnected) prev.focus();
    };
  }, []);

  useLayoutEffect(() => {
    runRef.current = run;
  });

  // Keep the active row in view by arithmetic (rows outside the window are not in the DOM to scroll to).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const top = LIST_PAD + active * ROW_H;
    if (top < list.scrollTop) list.scrollTop = top - LIST_PAD;
    else if (top + ROW_H + LIST_PAD > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_H + LIST_PAD - list.clientHeight;
  }, [active]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      if (n) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
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
            const first = Math.max(0, Math.floor((ev.currentTarget.scrollTop - LIST_PAD) / ROW_H));
            if (first !== scrollRow) setScrollRow(first);
          }}
        >
          {rows.length === 0 && <div className={styles.empty}>Type to search every menu and command.</div>}
          {(() => {
            // The window always holds the active row (the input's aria-activedescendant points at it).
            const from = Math.max(0, Math.min(scrollRow, active) - OVERSCAN);
            const to = Math.min(rows.length, Math.max(scrollRow + WINDOW_ROWS, active + 1 + OVERSCAN));
            return (
              <div style={{ paddingTop: from * ROW_H, paddingBottom: (rows.length - to) * ROW_H }}>
                {rows.slice(from, to).map((e, k) => (
                  <Row
                    key={e.key}
                    entry={e}
                    index={from + k}
                    isActive={from + k === active}
                    hover={setActive}
                    run={runStable}
                  />
                ))}
              </div>
            );
          })()}
        </div>
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
      </div>
    </div>
  );
}
