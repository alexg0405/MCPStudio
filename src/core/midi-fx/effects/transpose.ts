/**
 * Transpose: moves every note up or down by semitones and octaves. A note moved outside the keyboard (0–127) is dropped, as a
 * MIDI transposer does.
 */
import { p } from '@agstudio/sdk/params';
import { changedNote, isPlayableKey } from '../note-utils';
import type { FxNote, MidiFxDef } from '../types';

/** An octave in semitones. */
const OCTAVE = 12;

/** Transpose: see the file comment. */
export const transpose: MidiFxDef = {
  id: 'transpose',
  name: 'Transpose',
  short: 'TRN',
  description: 'Moves every note up or down by semitones and octaves.',
  params: {
    semitones: p.int(-24, 24, 0, { group: 'Move by', label: 'Semitones', unit: 'st', hint: 'How far to move the notes: 7 is a fifth up, -5 a fourth down' }),
    octaves: p.int(-4, 4, 0, { group: 'Move by', label: 'Octaves', hint: 'Moves the notes up or down whole octaves, on top of the semitones' }),
  },
  presets: [
    { name: 'Octave up', params: { octaves: 1 } },
    { name: 'Octave down', params: { octaves: -1 } },
    { name: 'Fifth up', params: { semitones: 7 } },
    { name: 'Two octaves down', params: { octaves: -2 } },
  ],
  reach: () => ({ before: 0, after: 0 }),
  run(input, run) {
    const out: FxNote[] = [];
    for (const note of input) {
      const shift = Math.round(run.param('semitones', note.start)) + OCTAVE * Math.round(run.param('octaves', note.start));
      const key = note.key + shift;
      if (isPlayableKey(key)) out.push(changedNote(note, { key }));
    }
    return out;
  },
};
