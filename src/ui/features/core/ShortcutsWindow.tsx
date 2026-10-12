import { useEffect, useState } from 'react';
import { formatChord } from '@core/commands/keymap';
import { useServices } from '../../services-context';
import styles from './ShortcutsWindow.module.css';

/** Lists every command that has a key binding, generated from the live keymap. */
export function ShortcutsWindow() {
  const { commands, keymap, platform } = useServices();
  const [, force] = useState(0);
  useEffect(() => {
    const a = keymap.subscribe(() => force((n) => n + 1));
    const b = commands.subscribe(() => force((n) => n + 1));
    return () => {
      a();
      b();
    };
  }, [commands, keymap]);

  const rows = commands
    .list()
    .map((def) => ({ def, chords: keymap.chordsFor(def.id) }))
    .filter((r) => r.chords.length > 0)
    .sort(
      (a, b) => (a.def.category ?? '').localeCompare(b.def.category ?? '') || a.def.title.localeCompare(b.def.title),
    );

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <tbody>
          {rows.map(({ def, chords }) => (
            <tr key={def.id}>
              <td className={styles.category}>{def.category ?? ''}</td>
              <td>{def.title}</td>
              <td className={styles.chords}>
                {chords.map((c) => (
                  <kbd key={c}>{formatChord(c, platform)}</kbd>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
