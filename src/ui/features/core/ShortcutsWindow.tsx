import { useEffect, useState } from 'react';
import { chordFromEvent, formatChord } from '@core/commands/keymap';
import type { Services } from '@app/services';
import { holdModal } from '../../controls/Dialog';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import { TOUCH_GESTURES } from '../../touch/gestures';
import { setCustomShortcuts, shortcutRows, type ShortcutRow } from './shortcut-rows';
import styles from './ShortcutsWindow.module.css';

/** Re-renders the window when a shortcut or a command changes. */
function useShortcutsChanging(services: Services): void {
  const { commands, keymap } = services;
  const [, force] = useState(0);
  useEffect(() => {
    const a = keymap.subscribe(() => force((n) => n + 1));
    const b = commands.subscribe(() => force((n) => n + 1));
    return () => {
      a();
      b();
    };
  }, [commands, keymap]);
}

/**
 * Recording a shortcut: `start(commandId)` waits for the next key combination and makes it a shortcut of that command
 * (a clash takes the chord away from the other command, and `note` says so). Esc cancels.
 */
function useShortcutRecorder(services: Services) {
  const { commands, keymap, platform, prefs } = services;
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!recording) return;
    const release = holdModal();
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // a modifier on its own: keep waiting
      const id = recording;
      const current = keymap.chordsFor(id);
      const clash = keymap.commandForChord(chord);
      const patch: Record<string, string[] | null> = {};
      if (!current.includes(chord)) patch[id] = [...current, chord];
      if (clash && clash !== id) {
        patch[clash] = keymap.chordsFor(clash).filter((c) => c !== chord);
        setNote(`${formatChord(chord, platform)} was “${commands.get(clash)?.title ?? clash}”; it now runs “${commands.get(id)?.title ?? id}”.`);
      } else {
        setNote('');
      }
      setCustomShortcuts(prefs, patch);
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      release();
    };
  }, [recording, keymap, commands, platform, prefs]);
  return { recording, start: setRecording, note, setNote };
}

/**
 * Every keyboard shortcut, and where you change them: + records a new one, × removes one, Reset
 * goes back to the built-in ones. Your shortcuts live in prefs (they replace a command's built-in
 * ones; a clash takes the chord away from the other command).
 */
export function ShortcutsWindow() {
  const services = useServices();
  const { commands, keymap, platform, prefs } = services;
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  useShortcutsChanging(services);
  const recorder = useShortcutRecorder(services);
  const { recording } = recorder;

  const rows = shortcutRows(commands, keymap, platform, query, showAll);
  const hasCustomShortcuts = Object.keys(prefs.getState().customKeys).length > 0;
  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <input className={styles.search} value={query} placeholder="Search shortcuts…" aria-label="Search shortcuts" onChange={(e) => setQuery(e.target.value)} data-hint="Find a command or a key" />
        <label className={styles.toggle} data-hint="Also list commands that have no shortcut yet, to give them one">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> All commands
        </label>
        <button
          className={styles.reset}
          disabled={!hasCustomShortcuts}
          onClick={() => {
            prefs.getState().set({ customKeys: {} });
            recorder.setNote('Every shortcut is back to the built-in one.');
          }}
          data-hint="Undo all your shortcut changes"
        >
          Reset all
        </button>
      </div>
      {(recorder.note || recording) && (
        <div className={styles.note} role="status">{recording ? `Press the new shortcut for “${commands.get(recording)?.title}”… (Esc to cancel)` : recorder.note}</div>
      )}
      <table className={styles.table} aria-label="Keyboard shortcuts">
        {/* Every button of the table (add, remove, reset) is one grid: one Tab stop, the arrow keys move between rows. */}
        <tbody data-roving="grid">
          {rows.map((row) => (
            <ShortcutRowView key={row.def.id} row={row} services={services} isRecording={recording === row.def.id} onRecord={() => recorder.start(row.def.id)} />
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className={styles.empty}>No command matches “{query}”.</div>}
      {!query && <TouchGestureList />}
    </div>
  );
}

/** What fingers do on a touchscreen (the same list as docs/shortcuts.md): there is no key to show for these. */
function TouchGestureList() {
  return (
    <section aria-label="Touch gestures">
      <h3 className={styles.touchTitle}>Touch gestures</h3>
      {TOUCH_GESTURES.map((group) => (
        <table key={group.where} className={styles.table}>
          <caption className={styles.touchWhere}>{group.where}</caption>
          <tbody>
            {group.gestures.map((g) => (
              <tr key={g.gesture}>
                <td className={styles.touchGesture}>{g.gesture}</td>
                <td>{g.what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </section>
  );
}

/** One command: its category, its title, its shortcuts (each removable) and the buttons to add one or go back to the built-in ones. */
function ShortcutRowView({ row, services, isRecording, onRecord }: { row: ShortcutRow; services: Services; isRecording: boolean; onRecord(): void }) {
  const { keymap, platform, prefs } = services;
  const { def, chords, custom } = row;
  return (
    <tr className={isRecording ? styles.recording : ''}>
      <td className={styles.category}>{def.category ?? ''}</td>
      <td data-hint={def.hint}>
        {def.title}
        {custom && <span className={styles.changed}> · yours</span>}
      </td>
      <td className={styles.chords}>
        {chords.map((c) => (
          <kbd key={c}>
            {formatChord(c, platform)}
            <button
              className={styles.remove}
              onClick={() => setCustomShortcuts(prefs, { [def.id]: chords.filter((x) => x !== c) })}
              data-hint={`Remove ${formatChord(c, platform)} from “${def.title}”`}
              aria-label={`Remove ${formatChord(c, platform)} from ${def.title}`}
            >
              <Icon name="close" size={9} />
            </button>
          </kbd>
        ))}
        <button className={styles.add} onClick={onRecord} data-hint={`Give “${def.title}” a new shortcut: click, then press the keys`} aria-label={`Add a shortcut to ${def.title}`}>
          <Icon name="plus" size={10} />
        </button>
        {custom && (
          <button
            className={styles.resetOne}
            onClick={() => setCustomShortcuts(prefs, { [def.id]: null })}
            data-hint={`Back to the built-in shortcut${keymap.defaultChordsFor(def.id).length === 1 ? '' : 's'}`}
            aria-label={`Reset the shortcuts of ${def.title}`}
          >
            Reset
          </button>
        )}
      </td>
    </tr>
  );
}
