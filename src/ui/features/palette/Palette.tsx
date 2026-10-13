import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createStore, useStore } from 'zustand';
import type { Services } from '@app/services';
import { holdModal } from '../../controls/Dialog';
import type { ActionEntry } from '../../shell/actions';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import { collectActions } from './collect';
import { pushRecent, searchActions } from './search';
import styles from './Palette.module.css';

/** Open/closed, outside React so the command and the overlay share it. */
export const paletteStore = createStore<{ open: boolean; query: string }>(() => ({ open: false, query: '' }));

export function togglePalette(query = ''): void {
  const open = !paletteStore.getState().open;
  paletteStore.setState({ open, query: open ? query : '' });
}

const MAX_ROWS = 80;

/** Hands the words to the AI studio: it opens and does it (one undoable change). */
function askAi(s: Services, text: string): void {
  openWindow(s, 'assistant');
  if (s.assistant.store.getState().phase !== 'idle') {
    s.session.getState().toast('The AI studio is still working on your last request.');
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
  // Gathered once per opening: menus and enabled states as they are right now.
  const entries = useMemo(() => collectActions(services), [services]);
  const recent = useMemo(() => services.prefs.getState().recentActions, [services]);

  const rows = useMemo(() => {
    const found = searchActions(entries, query, recent).slice(0, MAX_ROWS);
    const text = query.trim();
    if (!text) return found;
    const ai: ActionEntry = {
      key: 'ai',
      label: `Ask the AI: “${text}”`,
      path: ['AI studio'],
      hint: 'Claude does it for you in the AI studio. Every change it makes can be undone.',
      run: () => askAi(services, text),
    };
    // Nothing matches: asking the AI is the best bet, so it comes first.
    return found.length === 0 ? [ai] : [...found, ai];
  }, [entries, query, recent, services]);

  const close = () => paletteStore.setState({ open: false, query: '' });
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
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
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
        <div ref={listRef} id="ag-palette-list" className={styles.list} role="listbox">
          {rows.length === 0 && <div className={styles.empty}>Type to search every menu and command.</div>}
          {rows.map((e, i) => (
            <div
              key={e.key}
              id={`ag-palette-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              aria-disabled={e.disabled || undefined}
              className={`${styles.row} ${i === active ? styles.rowActive : ''} ${e.disabled ? styles.rowDisabled : ''} ${
                e.key === 'ai' ? styles.rowAi : ''
              }`}
              onPointerMove={() => i !== active && setActive(i)}
              onClick={() => run(e)}
            >
              <span className={styles.check}>{e.key === 'ai' ? '✦' : e.checked ? '✓' : ''}</span>
              <span className={styles.label}>{e.label}</span>
              <span className={styles.path}>{e.path.join(' › ')}</span>
              {e.chord && <kbd className={styles.chord}>{e.chord}</kbd>}
            </div>
          ))}
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
