import type { ChannelId } from '@core/model/types';
import { useDoc, useSession } from '../../services-context';
import { MidiFxPanel } from './MidiFxPanel';
import styles from './MidiFx.module.css';

/**
 * The MIDI effects window: the effects of the channel selected in the channel rack. Select another channel and it shows
 * that one's; a channel that plays audio (or none selected) says what to do instead.
 */
export function MidiFxWindow() {
  const selected = useSession((session) => session.selectedChannelId);
  const isInstrument = useDoc((project) => (selected ? project.channels[selected]?.kind === 'instrument' : false));
  if (!selected || !isInstrument) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyTitle}>Pick an instrument channel</span>
        <p className={styles.emptyText}>
          MIDI effects belong to a channel that plays notes. Click one in the channel rack and its effects show here.
        </p>
      </div>
    );
  }
  return (
    <div className={styles.windowScroll}>
      <MidiFxPanel channelId={selected as ChannelId} />
    </div>
  );
}
