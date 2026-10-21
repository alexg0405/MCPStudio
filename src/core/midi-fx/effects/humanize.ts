/**
 * Humanize: nudges each note's timing and velocity by a small random amount, so a programmed part sounds played. The amounts
 * are seeded draws of the note itself (its identity and start), so they are the same every time the note is heard, and editing
 * one note does not move the others.
 */
import { p } from '@agstudio/sdk/params';
import { clampVelocity, changedNote } from '../note-utils';
import { draw, hashText, tickBits } from '../random';
import type { FxNote, MidiFxDef } from '../types';

/** Which draw of a note is used for what, so timing and velocity do not follow each other. */
const TIMING_DRAW = 1;
const VELOCITY_DRAW = 2;
/** A milliseconds knob's top value: the reach of the effect is measured from it when the knob is automated. */
const MAX_TIMING_MS = 60;

/** Humanize: see the file comment. */
export const humanize: MidiFxDef = {
  id: 'humanize',
  name: 'Humanize',
  description: 'Moves each note a little early or late and a little louder or softer, a different small amount for every note.',
  params: {
    timing: p.float(0, MAX_TIMING_MS, 8, { label: 'Timing', unit: 'ms', hint: 'How far a note may be moved early or late. Live keys can only be moved later' }),
    velocity: p.float(0, 1, 0.1, { label: 'Velocity', unit: '%', hint: 'How much louder or softer a note may be' }),
    seed: p.int(0, 9999, 1, { label: 'Seed', automatable: false, hint: 'Which random pattern: the same seed always gives the same result' }),
  },
  presets: [
    { name: 'Loose', params: {} },
    { name: 'Tight', params: { timing: 3, velocity: 0.05 } },
    { name: 'Drunk drummer', params: { timing: 25, velocity: 0.25 } },
  ],
  reach: () => ({ before: 2400, after: 2400 }),
  run(input, run) {
    const out: FxNote[] = [];
    for (const note of input) {
      const identity = hashText(note.id);
      const timingMs = run.param('timing', note.start);
      const velocityAmount = run.param('velocity', note.start);
      let offsetMs = (draw(run.seed, identity, tickBits(note.start), TIMING_DRAW) * 2 - 1) * timingMs;
      // A live key cannot be played before it was pressed, so its offset only ever delays.
      if (run.context.live) offsetMs = Math.abs(offsetMs);
      const shift = run.context.msToTicks(offsetMs, note.start);
      const velocityShift = (draw(run.seed, identity, tickBits(note.start), VELOCITY_DRAW) * 2 - 1) * velocityAmount;
      out.push(changedNote(note, { start: note.start + shift, end: note.end + shift, velocity: clampVelocity(note.velocity + velocityShift) }));
    }
    return out;
  },
};
