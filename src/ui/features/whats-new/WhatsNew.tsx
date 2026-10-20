import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { holdModal } from '../../controls/Dialog';
import { useDialogFocus } from '../../controls/dialog-focus';
import { formatChord } from '@core/commands/keymap';
import { useServices } from '../../services-context';
import helpStyles from '../help/Help.module.css';
import { withShortcuts } from '../tours/TourOverlay';
import { spotlight } from '../tours/spotlight';
import { startTour } from '../tours/tour-state';
import { WHATS_NEW, WHATS_NEW_VERSION, type WhatsNewEntry } from './entries';
import { WhatsNewArtwork } from './Illustrations';
import { closeWhatsNew, whatsNewStore } from './whats-new-state';
import styles from './WhatsNew.module.css';

/** The What's new panel, while it is open. */
export function WhatsNewOverlay() {
  const open = useStore(whatsNewStore, (s) => s.open);
  return open ? <WhatsNew /> : null;
}

/**
 * A short, illustrated list of the newest features. "Show me" closes the panel, opens the window (or points at the menu) and
 * highlights it with a one-card spotlight, so the list leads to the real control instead of describing it.
 */
function WhatsNew() {
  const services = useServices();
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref);

  useEffect(() => {
    const release = holdModal();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeWhatsNew();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      release();
    };
  }, []);

  const chordOf = (command: string) => {
    const chord = services.keymap.chordsFor(command)[0];
    return chord ? formatChord(chord, services.platform) : null;
  };
  const show = (entry: WhatsNewEntry) => {
    closeWhatsNew();
    const step = { ...entry.show, body: withShortcuts(entry.show.body, chordOf) };
    void startTour(services, spotlight(step), { demo: false });
  };

  return (
    <div className={helpStyles.backdrop}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`${helpStyles.welcome} ${styles.panel}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-whatsnew-title"
        data-whats-new={WHATS_NEW_VERSION}
      >
        <h2 id="ag-whatsnew-title" className={helpStyles.title}>
          What’s <b>new</b>
        </h2>
        <p className={helpStyles.lead}>The newest things in AGstudio. “Show me” opens each one and points at it.</p>
        <ul className={styles.list}>
          {WHATS_NEW.map((entry) => (
            <li key={entry.id} className={styles.entry}>
              <WhatsNewArtwork art={entry.art} />
              <div className={styles.text}>
                <h3 className={styles.entryTitle}>{entry.title}</h3>
                <p className={styles.entryText}>{entry.text}</p>
              </div>
              <button
                className={helpStyles.button}
                onClick={() => show(entry)}
                data-hint={`Open ${entry.title} and point at it`}
                aria-label={`Show me: ${entry.title}`}
              >
                Show me
              </button>
            </li>
          ))}
        </ul>
        <div className={helpStyles.buttons}>
          <button
            className={helpStyles.button}
            onClick={() => {
              closeWhatsNew();
              services.commands.run('help.open');
            }}
            data-hint="Open the Help window: search everything AGstudio explains"
          >
            Open Help
          </button>
          <button
            className={`${helpStyles.button} ${helpStyles.primary}`}
            onClick={closeWhatsNew}
            data-hint="Close this list (Help → What’s new brings it back)"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
