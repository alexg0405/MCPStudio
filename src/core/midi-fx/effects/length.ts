/**
 * Note length: changes how long notes last. A fixed length plays every note for the same time, scale makes notes a share longer
 * or shorter, and legato holds each note until the next one starts (chords stay together).
 */
import { p } from '@agstudio/sdk/params';
import { changedNote, TICK_EPSILON } from '../note-utils';
import { LENGTH_IDS, noteValueLabels, noteValueTicks } from '../rates';
import type { FxNote, MidiFxDef } from '../types';

const MODES = ['fixed', 'scale', 'legato'];
const MODE_LABELS = { fixed: 'Fixed length', scale: 'Scale the length', legato: 'Legato (until the next note)' };
/** The longest a scaled note can get (as a share of its own length), the top of the knob. */
const MAX_SCALE = 4;

/** Note length: see the file comment. */
export const noteLength: MidiFxDef = {
  id: 'length',
  name: 'Note length',
  short: 'LEN',
  description: 'Changes how long notes last: all the same length, longer or shorter, or joined up until the next note.',
  params: {
    mode: p.enum(MODES, 'fixed', { group: 'Mode', label: 'Mode', labels: MODE_LABELS, hint: 'Fixed length, a share of each note’s own length, or until the next note starts' }),
    length: p.enum(LENGTH_IDS, '1/16', { group: 'Fixed length', label: 'Length', labels: noteValueLabels(LENGTH_IDS), hint: 'Fixed length mode: how long every note lasts' }),
    scale: p.float(0.1, MAX_SCALE, 1, { group: 'Scale', label: 'Scale', unit: '%', hint: 'Scale mode: 100% keeps the length, 50% halves it, 200% doubles it (live keys can only get longer)' }),
  },
  presets: [
    { name: 'Staccato', params: { mode: 'fixed', length: '1/32' } },
    { name: 'Sixteenth notes', params: {} },
    { name: 'Half length', params: { mode: 'scale', scale: 0.5 } },
    { name: 'Legato', params: { mode: 'legato' } },
  ],
  reach: () => ({ before: 0, after: 0 }),
  run(input, run) {
    const mode = String(run.values.mode);
    if (mode === 'legato') return legato(input);
    return input.map((note) => {
      if (mode === 'scale') {
        const scaled = (note.end - note.start) * run.param('scale', note.start);
        return changedNote(note, { end: note.start + Math.max(1, scaled) });
      }
      return changedNote(note, { end: note.start + noteValueTicks(String(run.values.length)) });
    });
  },
};

/** Each note lasts until the next note starts; the last note keeps its own length. */
function legato(input: readonly FxNote[]): FxNote[] {
  const sorted = [...input].sort((a, b) => a.start - b.start);
  // `next` only ever moves forward: notes are in start order, so the first later start is never earlier for a later note.
  let next = 0;
  return sorted.map((note) => {
    while (next < sorted.length && (sorted[next] as FxNote).start <= note.start + TICK_EPSILON) next++;
    const following = sorted[next];
    return following ? changedNote(note, { end: following.start }) : note;
  });
}
