/** A channel's MIDI effects as a line of the project text: "MIDI effects: Arpeggiator (rate 1/8, octaves 2) → Chord (shape min)". */
import type { ParamSpec } from '@agstudio/sdk';
import { midiFxDef, slotValues } from '@core/midi-fx/registry';
import type { InstrumentChannel } from '@core/model/types';
import { midiFxOf } from '@core/query/midi-fx';
import { round2 } from './units';

/**
 * The line under an instrument channel that has MIDI effects (empty text for one that has none, so projects without effects read
 * exactly as before): each effect in order with the settings that differ from its defaults; a bypassed one is marked.
 */
export function midiFxLine(channel: InstrumentChannel): string {
  const chain = midiFxOf(channel);
  if (chain.length === 0) return '';
  const parts = chain.map((slot) => {
    const def = midiFxDef(slot.effect);
    if (!def) return `${slot.effect} (unknown to this version)`;
    const values = slotValues(def, slot);
    const changed = (Object.entries(def.params) as [string, ParamSpec][])
      .filter(([id, spec]) => values[id] !== spec.default)
      .map(([id]) => `${id} ${typeof values[id] === 'number' ? round2(values[id] as number) : String(values[id])}`);
    const settings = changed.length ? ` (${changed.join(', ')})` : '';
    return `${slot.enabled ? '' : 'bypassed '}${def.name}${settings}`;
  });
  return `\n   MIDI effects (before the instrument, in this order): ${parts.join(' → ')}`;
}
