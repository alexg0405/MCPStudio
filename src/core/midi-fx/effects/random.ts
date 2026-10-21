/**
 * Random: lets some notes through and not others (a chance for each note) and sometimes throws a note up or down by octaves.
 * Each note's draw is its own (its identity and start), so the same part always plays the same way until you change the seed.
 */
import { p } from '@agstudio/sdk/params';
import { changedNote, isPlayableKey } from '../note-utils';
import { draw, hashText, tickBits } from '../random';
import type { FxNote, MidiFxDef } from '../types';

/** Which draw of a note is used for what, so the chance, the octave jump and its direction do not follow each other. */
const KEEP_DRAW = 1;
const JUMP_DRAW = 2;
const DIRECTION_DRAW = 3;
const SIZE_DRAW = 4;
/** An octave in semitones. */
const OCTAVE = 12;

/** Random: see the file comment. */
export const randomNotes: MidiFxDef = {
  id: 'random',
  name: 'Random',
  description: 'Plays each note only some of the time, and sometimes an octave or two higher or lower.',
  params: {
    chance: p.float(0, 1, 0.8, { label: 'Chance to play', unit: '%', hint: 'The chance that a note plays at all' }),
    jump: p.float(0, 1, 0.25, { label: 'Octave jump', unit: '%', hint: 'The chance that a note that plays is moved up or down by octaves' }),
    range: p.int(1, 3, 1, { label: 'Octaves', hint: 'The most octaves a jump may move a note' }),
    seed: p.int(0, 9999, 1, { label: 'Seed', automatable: false, hint: 'Which random pattern: the same seed always gives the same result' }),
  },
  presets: [
    { name: 'Sometimes', params: {} },
    { name: 'Sparse', params: { chance: 0.5, jump: 0 } },
    { name: 'Wild octaves', params: { chance: 0.95, jump: 0.6, range: 2 } },
  ],
  reach: () => ({ before: 0, after: 0 }),
  run(input, run) {
    const out: FxNote[] = [];
    for (const note of input) {
      const identity = hashText(note.id);
      const at = tickBits(note.start);
      if (draw(run.seed, identity, at, KEEP_DRAW) >= run.param('chance', note.start)) continue;
      if (draw(run.seed, identity, at, JUMP_DRAW) >= run.param('jump', note.start)) {
        out.push(note);
        continue;
      }
      const octaves = 1 + Math.floor(draw(run.seed, identity, at, SIZE_DRAW) * Math.round(run.param('range', note.start)));
      const direction = draw(run.seed, identity, at, DIRECTION_DRAW) < 0.5 ? -1 : 1;
      const key = note.key + direction * octaves * OCTAVE;
      // A jump off the keyboard turns around instead of dropping the note.
      const turned = isPlayableKey(key) ? key : note.key - direction * octaves * OCTAVE;
      out.push(isPlayableKey(turned) ? changedNote(note, { key: turned }) : note);
    }
    return out;
  },
};
