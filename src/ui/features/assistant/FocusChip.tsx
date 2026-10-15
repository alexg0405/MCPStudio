import { useStore } from 'zustand';
import { resolveFocus } from '@app/ai/focus';
import { useServices } from '../../services-context';
import { Icon } from '../../controls/Icon';
import styles from './Assistant.module.css';

/**
 * The part of the song the conversation is about, above the AI studio's box: the AI changes only it.
 * ▶ plays it on a loop, × asks about the whole song again.
 */
export function FocusChip() {
  const services = useServices();
  const a = services.assistant;
  const focus = useStore(a.store, (s) => s.focus);
  const busy = useStore(a.store, (s) => s.phase !== 'idle');
  const label = useStore(services.doc, (d) => (focus ? (resolveFocus(d.project, focus)?.label ?? null) : null));
  if (!focus || !label) return null;
  return (
    <div
      className={styles.focusChip}
      data-hint={`Studio changes only ${label}; the rest of the song stays exactly as it is`}
    >
      <span className={styles.focusSpark}>
        <Icon name="studio" size={13} />
      </span>
      <span className={styles.focusLabel}>About {label}</span>
      <button
        className={styles.focusButton}
        onClick={() => void a.playFocus()}
        data-hint="Play this part on a loop"
        aria-label="Play this part"
      >
        ▶
      </button>
      <button
        className={styles.focusButton}
        disabled={busy}
        onClick={() => a.setFocus(null)}
        data-hint="Stop working on this part: the next request is about the whole song"
        aria-label="Ask about the whole song"
      >
        ×
      </button>
    </div>
  );
}
