import { useEffect } from 'react';
import { KIT } from '@core/model/kit';
import { addInstrumentChannel, addKitChannel } from '@app/actions/channels';
import type { Services } from '@app/services';
import { useDoc, useView } from '../../services-context';
import { type MenuEntry } from '../../controls/ContextMenu';
import styles from './ChannelRack.module.css';
import { RackHeader } from './RackHeader';
import { RackRows } from './RackRows';
import { endPaint } from './step-paint';

/** "Add" entries: kit sounds and instrument plugins. */
export function addChannelMenu(services: Services): MenuEntry[] {
  const instruments = services.plugins.list('instrument');
  return [
    { kind: 'label', label: 'Kit sounds' },
    ...KIT.map((k) => ({ label: k.name, onSelect: () => void addKitChannel(services, k.generator) })),
    { kind: 'separator' },
    { kind: 'label', label: 'Instruments' },
    ...instruments.map((e) => ({
      label: e.source === 'user' ? `${e.def.name} (user)` : e.def.name,
      onSelect: () => void addInstrumentChannel(services, e.def.id),
    })),
  ];
}

export function ChannelRack() {
  const patternId = useView((s) => s.currentPatternId);
  // Only the step count, not the pattern: a step click makes a new pattern object, and the rack (150 rows in a long
  // song) re-rendered on every one only to find that every row is unchanged.
  const stepCountOf = useDoc((pr) => (patternId ? pr.patterns[patternId]?.stepCount : undefined));
  // Letting go anywhere ends a paint along a row.
  useEffect(() => {
    window.addEventListener('pointerup', endPaint);
    window.addEventListener('pointercancel', endPaint);
    return () => {
      window.removeEventListener('pointerup', endPaint);
      window.removeEventListener('pointercancel', endPaint);
    };
  }, []);

  if (!patternId || stepCountOf === undefined)
    return (
      <div className={styles.empty}>
        No pattern is open. Pick one under Project patterns in the browser, or click “+ New pattern” there.
      </div>
    );

  return (
    <div className={styles.rack}>
      <RackHeader patternId={patternId} stepCount={stepCountOf} />
      <RackRows patternId={patternId} stepCount={stepCountOf} />
    </div>
  );
}
