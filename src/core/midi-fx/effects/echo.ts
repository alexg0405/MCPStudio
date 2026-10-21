/**
 * MIDI echo: after each note, plays copies of it a synced time apart. Every echo is quieter than the one before it (the
 * feedback), can be a little higher or lower in pitch, and can be shorter.
 */
import { p } from '@agstudio/sdk/params';
import { clampVelocity, derivedNote, isPlayableKey, MIN_VELOCITY } from '../note-utils';
import { ECHO_DELAY_IDS, noteValueLabels, noteValueTicks } from '../rates';
import type { FxNote, MidiFxDef } from '../types';

/** An echo quieter than this (0–1) is not played: the echo has died away. */
const AUDIBLE_VELOCITY = 0.02;
/** How long an echo of a key that is still held lasts, as a share of the delay (its real length is not known yet). */
const OPEN_ECHO_GATE = 0.9;
/** The most echoes the repeats knob allows. */
const MAX_REPEATS = 16;

/** MIDI echo: see the file comment. */
export const echo: MidiFxDef = {
  id: 'echo',
  name: 'MIDI echo',
  description: 'Repeats each note a few times, a synced time apart, each echo quieter than the last and optionally higher or lower.',
  params: {
    delay: p.enum(ECHO_DELAY_IDS, '1/8.', { label: 'Delay', labels: noteValueLabels(ECHO_DELAY_IDS), hint: 'The time between a note and its echo, as a note value of the song tempo' }),
    repeats: p.int(1, MAX_REPEATS, 4, { label: 'Echoes', hint: 'How many echoes follow each note' }),
    feedback: p.float(0, 1, 0.65, { label: 'Feedback', unit: '%', hint: 'How loud each echo is compared with the one before it' }),
    pitch: p.float(-12, 12, 0, { label: 'Pitch per echo', unit: 'st', hint: 'How many semitones each echo moves up or down compared with the one before' }),
    decay: p.float(0.2, 1, 1, { label: 'Length per echo', unit: '%', hint: 'How long each echo lasts compared with the one before it (100% keeps the note’s length)' }),
  },
  presets: [
    { name: 'Dotted eighth echo', params: {} },
    { name: 'Rising echoes', params: { delay: '1/8', pitch: 3, feedback: 0.7, repeats: 5 } },
    { name: 'Slap back', params: { delay: '1/16', repeats: 1, feedback: 0.5 } },
    { name: 'Falling triplets', params: { delay: '1/8t', pitch: -2, repeats: 6, decay: 0.8 } },
  ],
  reach(values) {
    return { before: 0, after: noteValueTicks(String(values.delay)) * MAX_REPEATS };
  },
  run(input, run) {
    const out: FxNote[] = [];
    for (const note of input) {
      out.push(note);
      const delay = noteValueTicks(String(run.values.delay));
      const repeats = Math.round(run.param('repeats', note.start));
      const feedback = run.param('feedback', note.start);
      const pitch = run.param('pitch', note.start);
      const decay = run.param('decay', note.start);
      const length = Number.isFinite(note.end) ? note.end - note.start : delay * OPEN_ECHO_GATE;
      const firstEcho = Math.max(1, Math.floor((run.from - note.start) / delay) - 1);
      for (let echoNumber = firstEcho; echoNumber <= repeats; echoNumber++) {
        const start = note.start + echoNumber * delay;
        if (start >= run.to) break;
        const velocity = note.velocity * feedback ** echoNumber;
        const key = Math.round(note.key + pitch * echoNumber);
        if (velocity < AUDIBLE_VELOCITY || !isPlayableKey(key)) continue;
        const echoLength = Math.max(1, length * decay ** echoNumber);
        out.push(derivedNote(note, `e${echoNumber}`, { start, end: start + echoLength, key, velocity: Math.max(MIN_VELOCITY, clampVelocity(velocity)) }));
      }
    }
    return out;
  },
};
