/**
 * Scale: keeps every note inside a scale. A note outside it is moved to the nearest note of the scale ("snap") or dropped
 * ("filter"). The scale can be the song key, the notes of the chord the chord track has at that moment, or one you pick.
 */
import { p } from '@agstudio/sdk/params';
import { PITCH_NAMES_FOR_PARAMS } from '../pitch-names';
import { changedNote } from '../note-utils';
import { chordMask, keyMask, maskOf, scaleLabel, snapKey, SCALE_IDS, type PitchMask, type SnapDirection } from '../scale-tools';
import type { FxNote, FxRun, MidiFxDef } from '../types';
import { scalePitchClasses } from '../../harmony/scale';

const SOURCES = ['song', 'chordTrack', 'custom'];
const SOURCE_LABELS = { song: 'The song key', chordTrack: 'The chord track', custom: 'A scale I pick' };
const MODES = ['snap', 'filter'];
const MODE_LABELS = { snap: 'Move to the nearest note', filter: 'Drop notes outside' };
const DIRECTIONS = ['nearest', 'up', 'down'];
const DIRECTION_LABELS = { nearest: 'Nearest note', up: 'Up', down: 'Down' };

/** The notes allowed for a note starting at `start`, or null when the effect has nothing to go by (no song key, no chord there). */
function allowedAt(run: FxRun, start: number): PitchMask | null {
  switch (String(run.values.source)) {
    case 'song':
      return run.context.key ? keyMask(run.context.key) : null;
    case 'chordTrack': {
      const chord = run.context.chordAt(start);
      return chord ? chordMask(chord) : null;
    }
    default: {
      const root = Math.max(0, PITCH_NAMES_FOR_PARAMS.indexOf(String(run.values.root)));
      return maskOf(scalePitchClasses({ root, scale: String(run.values.scale) }));
    }
  }
}

/** Scale: see the file comment. */
export const scale: MidiFxDef = {
  id: 'scale',
  name: 'Scale',
  short: 'SCL',
  description: 'Keeps every note in a scale: notes outside it move to the nearest note of the scale, or are dropped.',
  params: {
    source: p.enum(SOURCES, 'song', { group: 'Scale', label: 'Scale from', labels: SOURCE_LABELS, hint: 'The notes that are allowed: the song key, the chord on the chord track, or a scale you pick' }),
    root: p.enum(PITCH_NAMES_FOR_PARAMS, 'C', { group: 'Scale', label: 'Root', hint: 'A scale I pick: its first note' }),
    scale: p.enum(SCALE_IDS, 'major', {
      group: 'Scale',
      label: 'Scale',
      labels: Object.fromEntries(SCALE_IDS.map((id) => [id, scaleLabel(id)])),
      hint: 'A scale I pick: which scale',
    }),
    mode: p.enum(MODES, 'snap', { group: 'Notes outside', label: 'Notes outside', labels: MODE_LABELS, hint: 'Move them into the scale, or drop them' }),
    direction: p.enum(DIRECTIONS, 'nearest', { group: 'Notes outside', label: 'Move', labels: DIRECTION_LABELS, hint: 'Which way a note outside the scale moves' }),
  },
  presets: [
    { name: 'Snap to the song key', params: {} },
    { name: 'Only the song key’s notes', params: { mode: 'filter' } },
    { name: 'Chord tones only', params: { source: 'chordTrack', mode: 'snap' } },
    { name: 'A minor pentatonic', params: { source: 'custom', root: 'A', scale: 'minor-pentatonic' } },
  ],
  reach: () => ({ before: 0, after: 0 }),
  run(input, run) {
    const out: FxNote[] = [];
    const direction = String(run.values.direction) as SnapDirection;
    const filter = String(run.values.mode) === 'filter';
    for (const note of input) {
      const allowed = allowedAt(run, note.start);
      if (!allowed) {
        out.push(note);
        continue;
      }
      const target = snapKey(note.key, allowed, direction);
      if (target === note.key) out.push(note);
      else if (!filter && target !== null) out.push(changedNote(note, { key: target }));
    }
    return out;
  },
};
