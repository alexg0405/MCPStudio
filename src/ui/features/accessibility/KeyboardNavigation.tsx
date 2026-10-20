import { useServices } from '../../services-context';
import { KEYBOARD_NAVIGATION, SCREEN_READER_NOTES, spellOutKeys } from '../../a11y/keyboard-help-data';
import styles from './KeyboardNavigation.module.css';

/**
 * How to use AGstudio with the keyboard alone and with a screen reader: the keys everywhere, in menus and lists, on
 * controls, and in each editor, then what a screen reader says. The same data goes into docs/shortcuts.md.
 */
export function KeyboardNavigationList({ heading = true }: { heading?: boolean }) {
  const { platform } = useServices();
  return (
    <section aria-label="Keyboard navigation and screen reader" className={styles.list}>
      {heading && <h3 className={styles.title}>Keyboard navigation</h3>}
      {KEYBOARD_NAVIGATION.map((group) => (
        <table key={group.where} className={styles.table}>
          <caption className={styles.where}>{group.where}</caption>
          <tbody>
            {group.moves.map((move) => (
              <tr key={move.keys}>
                <th scope="row" className={styles.keys}>
                  <kbd>{spellOutKeys(move.keys, platform)}</kbd>
                </th>
                <td>{move.what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      <h3 className={styles.title}>With a screen reader</h3>
      <ul className={styles.notes}>
        {SCREEN_READER_NOTES.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

/** The Help → Keyboard navigation window: the list on its own page. */
export function KeyboardHelpWindow() {
  return (
    <div className={styles.wrap}>
      <KeyboardNavigationList heading={false} />
    </div>
  );
}
