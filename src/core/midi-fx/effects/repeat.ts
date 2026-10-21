/**
 * Note repeat (roll): plays each note again and again at a fast rate for as long as it lasts, like a hi-hat roll, with the
 * loudness rising or falling along the roll.
 */
import { p } from '@agstudio/sdk/params';
import { clampVelocity, TICK_EPSILON, noteLike } from '../note-utils';
import { noteValueLabels, noteValueTicks, ROLL_RATE_IDS } from '../rates';
import type { FxNote, MidiFxDef } from '../types';

/** A roll with no end (a held key, live) takes its loudness ramp over this many hits. */
const OPEN_ROLL_RAMP_HITS = 16;
/** The quietest a ramp makes a hit, as a share of the note's velocity. */
const MIN_RAMP_LEVEL = 0.05;
/** The most hits a roll makes in one note (a safety limit for very long notes at the fastest rate). */
const MAX_HITS = 512;

/** Note repeat: see the file comment. */
export const repeat: MidiFxDef = {
  id: 'repeat',
  name: 'Note repeat',
  description: 'Plays each note again and again at a fast rate while it lasts, like a hi-hat roll, getting louder or softer along the way.',
  params: {
    rate: p.enum(ROLL_RATE_IDS, '1/16', { label: 'Rate', labels: noteValueLabels(ROLL_RATE_IDS), hint: 'How fast the note repeats, as a note value of the song tempo' }),
    count: p.int(0, 32, 0, { label: 'Hits', hint: 'How many times each note plays; 0 repeats it for as long as the note lasts' }),
    gate: p.float(0.05, 1, 0.7, { label: 'Gate', unit: '%', hint: 'How long each hit lasts as a share of the time to the next one' }),
    ramp: p.float(-1, 1, 0, { label: 'Ramp', unit: '%', hint: 'Whether the roll gets louder (above 0) or softer (below 0) from its first hit to its last' }),
  },
  presets: [
    { name: 'Hi-hat roll 1/16', params: {} },
    { name: 'Fast roll 1/32, building up', params: { rate: '1/32', ramp: 0.8, gate: 0.6 } },
    { name: 'Triplet roll, fading out', params: { rate: '1/16t', ramp: -0.7 } },
    { name: 'Four quick hits', params: { rate: '1/32', count: 4, ramp: -0.4 } },
  ],
  reach: () => ({ before: 0, after: 0 }),
  run(input, run) {
    const out: FxNote[] = [];
    for (const note of input) {
      const step = noteValueTicks(String(run.values.rate));
      const count = Math.round(run.param('count', note.start));
      const hits = count > 0 ? count : Math.max(1, Math.round((note.end - note.start) / step - TICK_EPSILON));
      const isOpen = !Number.isFinite(note.end) && count === 0;
      const rampHits = isOpen ? OPEN_ROLL_RAMP_HITS : hits;
      const gate = run.param('gate', note.start);
      const ramp = run.param('ramp', note.start);
      const firstHit = Math.max(0, Math.floor((run.from - note.start) / step) - 1);
      for (let hit = firstHit; hit < Math.min(hits, MAX_HITS); hit++) {
        const start = note.start + hit * step;
        if (start >= run.to) break;
        const progress = rampHits > 1 ? Math.min(1, hit / (rampHits - 1)) : 0;
        const level = Math.max(MIN_RAMP_LEVEL, 1 + ramp * progress);
        const velocity = clampVelocity(note.velocity * level);
        out.push(noteLike(`${note.id}:r${hit}`, note, { start, end: start + Math.max(1, gate * step), velocity }));
      }
    }
    return out;
  },
};
