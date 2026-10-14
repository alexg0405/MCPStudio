import { useEffect, useState } from 'react';
import { chordFromEvent, formatChord } from '@core/commands/keymap';
import { holdModal } from '../../controls/Dialog';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import styles from './ShortcutsWindow.module.css';

/**
 * Every keyboard shortcut, and where you change them: + records a new one, × removes one, Reset
 * goes back to the built-in ones. Your shortcuts live in prefs (they replace a command's built-in
 * ones; a clash takes the chord away from the other command).
 */
export function ShortcutsWindow() {
  const services = useServices();
  const { commands, keymap, platform, prefs } = services;
  const [, force] = useState(0);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    const a = keymap.subscribe(() => force((n) => n + 1));
    const b = commands.subscribe(() => force((n) => n + 1));
    return () => {
      a();
      b();
    };
  }, [commands, keymap]);

  const setKeys = (patch: Record<string, string[] | null>) => {
    const next = { ...prefs.getState().customKeys };
    for (const [id, chords] of Object.entries(patch)) {
      if (chords === null) delete next[id];
      else next[id] = chords;
    }
    prefs.getState().set({ customKeys: next });
  };

  // Recording: the next key combination becomes a shortcut of `recording`.
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
        setNote(
          `${formatChord(chord, platform)} was “${commands.get(clash)?.title ?? clash}”; it now runs “${commands.get(id)?.title ?? id}”.`,
        );
      } else setNote('');
      setKeys(patch);
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      release();
    };
    // setKeys only reads stores; re-arming on its identity would drop keystrokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, keymap, commands, platform]);

  // Rebuilt every render (a couple of hundred commands): the keymap changes in place.
  const q = query.trim().toLowerCase();
  const rows = commands
    .list()
    .map((def) => ({ def, chords: keymap.chordsFor(def.id), custom: keymap.isCustomized(def.id) }))
    .filter((r) => showAll || q || r.chords.length > 0 || r.custom)
    .filter(
      (r) =>
        !q ||
        `${r.def.title} ${r.def.category ?? ''} ${r.def.hint ?? ''} ${r.chords.map((c) => formatChord(c, platform)).join(' ')}`
          .toLowerCase()
          .includes(q),
    )
    .sort(
      (a, b) => (a.def.category ?? '').localeCompare(b.def.category ?? '') || a.def.title.localeCompare(b.def.title),
    );

  const anyCustom = Object.keys(prefs.getState().customKeys).length > 0;
  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <input
          className={styles.search}
          value={query}
          placeholder="Search shortcuts…"
          onChange={(e) => setQuery(e.target.value)}
          data-hint="Find a command or a key"
        />
        <label className={styles.toggle} data-hint="Also list commands that have no shortcut yet, to give them one">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> All commands
        </label>
        <button
          className={styles.reset}
          disabled={!anyCustom}
          onClick={() => {
            prefs.getState().set({ customKeys: {} });
            setNote('Every shortcut is back to the built-in one.');
          }}
          data-hint="Undo all your shortcut changes"
        >
          Reset all
        </button>
      </div>
      {(note || recording) && (
        <div className={styles.note}>
          {recording ? `Press the new shortcut for “${commands.get(recording)?.title}”… (Esc to cancel)` : note}
        </div>
      )}
      <table className={styles.table}>
        <tbody>
          {rows.map(({ def, chords, custom }) => (
            <tr key={def.id} className={recording === def.id ? styles.recording : ''}>
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
                      onClick={() => setKeys({ [def.id]: chords.filter((x) => x !== c) })}
                      data-hint={`Remove ${formatChord(c, platform)} from “${def.title}”`}
                      aria-label="Remove shortcut"
                    >
                      <Icon name="close" size={9} />
                    </button>
                  </kbd>
                ))}
                <button
                  className={styles.add}
                  onClick={() => setRecording(def.id)}
                  data-hint={`Give “${def.title}” a new shortcut: click, then press the keys`}
                  aria-label="Add shortcut"
                >
                  <Icon name="plus" size={10} />
                </button>
                {custom && (
                  <button
                    className={styles.resetOne}
                    onClick={() => setKeys({ [def.id]: null })}
                    data-hint={`Back to the built-in shortcut${keymap.defaultChordsFor(def.id).length === 1 ? '' : 's'}`}
                  >
                    Reset
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className={styles.empty}>No command matches “{query}”.</div>}
    </div>
  );
}
