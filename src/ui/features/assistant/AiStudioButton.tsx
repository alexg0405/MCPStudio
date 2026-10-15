import { useStore } from 'zustand';
import { formatChord } from '@core/commands/keymap';
import { useCommandState } from '../../shell/command-state';
import { useServices } from '../../services-context';
import { Icon } from '../../controls/Icon';
import styles from './Assistant.module.css';

/**
 * The toolbar's Studio pill (the Studio mark and "Studio"), first after the transport: a gold edge while the window is
 * closed, brushed gold while it is open, a soft shimmer while the AI works. It re-renders only when
 * the window opens or closes or the AI starts or stops working.
 */
export function AiStudioButton() {
  const services = useServices();
  const { checked } = useCommandState('view.assistant');
  const busy = useStore(services.assistant.store, (s) => s.phase !== 'idle' || !!s.building);
  const chord = services.keymap.chordsFor('view.assistant')[0];
  const keys = chord ? ` (${formatChord(chord, services.platform)})` : '';
  return (
    <button
      className={`${styles.aiPill} ${checked ? styles.aiPillOn : ''} ${busy ? styles.aiPillBusy : ''}`}
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => services.commands.run('view.assistant')}
      data-hint={`${checked ? 'Hide Studio' : 'Ask Studio to make or change anything'}${keys}${busy ? ' · Studio is working' : ''}`}
      aria-label="Studio"
      aria-pressed={checked}
      data-tour="assistant"
    >
      <span className={styles.aiPillMark} aria-hidden>
        <Icon name="studio" size={15} />
      </span>
      Studio
    </button>
  );
}
