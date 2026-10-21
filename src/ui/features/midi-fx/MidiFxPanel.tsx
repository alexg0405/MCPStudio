import { useCallback, useMemo, useState } from 'react';
import type { ChannelId } from '@core/model/types';
import { hasActiveMidiFx, midiFxOf } from '@core/query/midi-fx';
import { addMidiEffect, bakeMidiEffects, MIDI_EFFECT_CHOICES, moveMidiEffectTo } from '@app/actions/midi-fx';
import { showContextMenu } from '../../controls/ContextMenu';
import { useDoc, useServices } from '../../services-context';
import { MidiFxCard, type DropSide, type ReorderState } from './MidiFxCard';
import { addEffectEntries, chainEntries, report } from './menus';
import styles from './MidiFx.module.css';

/** The effects an empty chain offers as one-click buttons (the rest are in the Add menu). */
const QUICK_EFFECTS: readonly (readonly [id: string, label: string])[] = [
  ['arp', 'Arpeggiator'],
  ['chord', 'Chord'],
  ['scale', 'Scale'],
  ['echo', 'MIDI echo'],
  ['humanize', 'Humanize'],
];

/** Drag-and-drop state for the list: which effect is being dragged, and where it would land. */
function useReorder(channelId: ChannelId, order: readonly string[]): ReorderState {
  const services = useServices();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<ReorderState['over']>(null);
  return useMemo(
    () => ({
      dragging,
      over,
      start: setDragging,
      hover: (slotId: string, side: DropSide) =>
        setOver((previous) => (previous?.slotId === slotId && previous.side === side ? previous : { slotId, side })),
      drop() {
        if (dragging && over) {
          const from = order.indexOf(dragging);
          const target = order.indexOf(over.slotId);
          const landing = over.side === 'before' ? target : target + 1;
          const to = landing > from ? landing - 1 : landing;
          if (from >= 0 && target >= 0 && to !== from) moveMidiEffectTo(services, channelId, dragging as never, to);
        }
        setDragging(null);
        setOver(null);
      },
      cancel() {
        setDragging(null);
        setOver(null);
      },
    }),
    [dragging, over, order, services, channelId],
  );
}

/**
 * A channel's MIDI effects: the effects in the order the notes go through them, with their knobs, and the buttons to add one,
 * load a chain and render the effects into the notes. Shared by the MIDI effects window and the foot of an instrument's window.
 */
export function MidiFxPanel({ channelId }: { channelId: ChannelId }) {
  const services = useServices();
  const chain = useDoc((project) => midiFxOf(project.channels[channelId]));
  const channel = useDoc((project) => project.channels[channelId]);
  const reorder = useReorder(channelId, useMemo(() => chain.map((slot) => slot.id), [chain]));
  const openMenu = useCallback(
    (e: { currentTarget: HTMLElement }, entries: Parameters<typeof showContextMenu>[1]) => {
      const box = e.currentTarget.getBoundingClientRect();
      showContextMenu({ clientX: box.left, clientY: box.bottom + 2 }, entries);
    },
    [],
  );
  if (!channel || channel.kind !== 'instrument') return null;

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar} role="toolbar" aria-label={`MIDI effects of ${channel.name}`} data-roving>
        <span className={styles.toolbarTitle}>MIDI effects</span>
        <button
          type="button"
          className={`${styles.button} ${chain.length === 0 ? styles.primary : ''}`}
          aria-haspopup="menu"
          data-hint="Add an effect to the end of the chain: it changes the notes on their way to the instrument"
          onClick={(e) => openMenu(e, addEffectEntries(services, channelId))}
        >
          + Add effect ▾
        </button>
        <button
          type="button"
          className={styles.button}
          aria-haspopup="menu"
          data-hint="Ready-made chains, your saved chains, saving this one, and removing all effects"
          onClick={(e) => openMenu(e, chainEntries(services, channelId))}
        >
          Chains ▾
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={!hasActiveMidiFx(channel)}
          data-hint="Write what the effects make into the patterns as notes (one undo step) and take the effects out of the way"
          onClick={() => report(services, bakeMidiEffects(services, channelId))}
        >
          Render to notes
        </button>
      </div>
      {chain.length === 0 ? (
        <div className={styles.empty}>
          <span className={styles.emptyTitle}>No MIDI effects on {channel.name}</span>
          <p className={styles.emptyText}>
            MIDI effects change the notes on their way to the instrument, for the keys you play and for the song: an arpeggiator turns
            a held chord into a pattern, Chord adds notes, Scale keeps everything in key. Add one to try it.
          </p>
          <div className={styles.quickAdd}>
            {QUICK_EFFECTS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={styles.button}
                data-hint={`Add ${label}: ${MIDI_EFFECT_CHOICES.find((choice) => choice.id === id)?.description ?? ''}`}
                onClick={() => addMidiEffect(services, channelId, id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ol className={styles.list} aria-label={`MIDI effects of ${channel.name}, first to last`}>
          {chain.map((slot, index) => (
            <MidiFxCard key={slot.id} channelId={channelId} slot={slot} index={index} count={chain.length} reorder={reorder} />
          ))}
        </ol>
      )}
    </div>
  );
}
