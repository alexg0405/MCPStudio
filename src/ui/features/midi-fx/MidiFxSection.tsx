import { useState } from 'react';
import type { ChannelId } from '@core/model/types';
import { midiFxOf, midiFxSummary } from '@core/query/midi-fx';
import { useDoc } from '../../services-context';
import { MidiFxPanel } from './MidiFxPanel';
import styles from './MidiFx.module.css';

/**
 * The foot of an instrument's window: the channel's MIDI effects, folded away until you want them (open by itself when the
 * channel has some), so the instrument's own controls keep the room.
 */
export function MidiFxSection({ channelId }: { channelId: ChannelId }) {
  const chain = useDoc((project) => midiFxOf(project.channels[channelId]));
  const summary = useDoc((project) => midiFxSummary(project.channels[channelId]));
  const [chosen, setChosen] = useState<boolean | null>(null);
  const isOpen = chosen ?? chain.length > 0;
  return (
    <section className={styles.section} aria-label="MIDI effects">
      <button
        type="button"
        className={styles.sectionBar}
        aria-expanded={isOpen}
        onClick={() => setChosen(!isOpen)}
        data-hint="MIDI effects change the notes on their way to this instrument: an arpeggiator, chords, scale, echo and more. Click to show or hide them"
      >
        <span aria-hidden>{isOpen ? '▾' : '▸'}</span>
        <span>MIDI effects</span>
        <span className={styles.sectionSummary}>{summary || 'none yet: add an arpeggiator, chords or a scale'}</span>
      </button>
      {isOpen && <MidiFxPanel channelId={channelId} />}
    </section>
  );
}
