import type { BeatNote } from '../spec';
import { STEPS_PER_BAR } from '../spec';
import { bassKey } from '../theory';

const MINOR = [0, 2, 3, 5, 7, 8, 10];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** The nearest key that is in the scale (a tie goes to the lower one). */
export function snapToScale(key: number, root: number, minor: boolean): number {
  const scale = minor ? MINOR : MAJOR;
  for (let d = 0; d <= 6; d++) {
    for (const k of [key - d, key + d]) if (scale.includes((((k - root) % 12) + 12) % 12)) return k;
  }
  return key;
}

/** The highest key an 808 slides to (C3): above it the 808 stops sounding like a bass. */
const MAX_808 = 48;
/** The distinct steps a kick plays on, in order (the bass follows them). */
function kickSteps(kick: readonly BeatNote[]): number[] {
  return [...new Set(kick.map((n) => n.step))].sort((a, b) => a - b);
}

/**
 * An 808 line that follows the kick (roots, the ♭7 or 5th on the last hit of every second bar),
 * every hit ringing until the next one. Slides: the last note of the loop (after the pickup kick),
 * and with `everyBar` the last note of every bar, glides into a new pitch for its last step; it is
 * stretched half a step into the new note, so the 808 slides instead of hitting again.
 */
export function eightOhEight(
  kick: readonly BeatNote[],
  bars: number,
  root808: number,
  minor: boolean,
  everyBar: boolean,
): BeatNote[] {
  const total = bars * STEPS_PER_BAR;
  const hits = kickSteps(kick);
  const notes: BeatNote[] = [];
  hits.forEach((step, i) => {
    const next = hits[i + 1] ?? total;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const isLastInBar = (hits[i + 1] ?? Infinity) >= (bar + 1) * STEPS_PER_BAR;
    const key = bar % 2 === 1 && isLastInBar ? root808 + (minor ? -2 : 7) : root808;
    notes.push({ step, len: Math.max(1, next - step), key, vel: 0.9 });
  });
  for (let bar = everyBar ? 0 : bars - 1; bar < bars; bar++) addSlide(notes, bar, bars, root808);
  return notes.sort((a, b) => a.step - b.step);
}

/** Slides the last note of a bar into a new pitch: a second note half a step into the first. */
function addSlide(notes: BeatNote[], bar: number, bars: number, root808: number): void {
  const last = notes.filter((n) => n.step >= bar * STEPS_PER_BAR && n.step < (bar + 1) * STEPS_PER_BAR).at(-1);
  const len = last?.len ?? 0;
  if (!last || len < 1.5) return;
  const at = last.step + Math.max(0.5, len - 1);
  const from = last.key ?? root808;
  // Up an octave into the loop's restart; a 5th up (or the octave below) inside the loop.
  const interval = bar === bars - 1 ? 12 : 7;
  const key = from + interval <= MAX_808 ? from + interval : from - 12;
  notes.push({ step: at, len: last.step + len - at, key, vel: 0.85 });
  last.len = at - last.step + 0.5;
}

/** A sub bass under the kick: the root on each hit, short of the next one (boom bap, afro, pop). */
export function subUnderKick(
  kick: readonly BeatNote[],
  bars: number,
  rootBass: number,
  roots?: readonly number[],
): BeatNote[] {
  const total = bars * STEPS_PER_BAR;
  const hits = kickSteps(kick);
  return hits.map((step, i) => {
    const next = hits[i + 1] ?? total;
    const bar = Math.floor(step / STEPS_PER_BAR);
    const shift = roots ? (roots[bar % roots.length] ?? 0) : 0;
    return { step, len: Math.max(0.5, Math.min(6, next - step - 0.25)), key: bassKey(rootBass + shift), vel: 0.85 };
  });
}

/** An offbeat bass (house, EDM): a short note on the "and" of every beat, on the chords' roots when given. */
export function offbeatBass(bars: number, rootBass: number, roots: readonly number[]): BeatNote[] {
  return Array.from({ length: bars * 4 }, (_, i) => ({
    step: i * 4 + 2,
    len: 1.5,
    key: bassKey(rootBass + (roots[Math.floor(i / 4) % roots.length] ?? 0)),
    vel: 0.8,
  }));
}
