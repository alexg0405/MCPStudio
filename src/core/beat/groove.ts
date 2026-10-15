/**
 * The groove of a beat written without velocities: each style's accents (hats per 1/16 of the beat,
 * kicks hardest on the bar's downbeat, snares and claps full on their main hits with soft ghost
 * notes, rolls that rise, 808s firm) plus a little seeded jitter so repeats aren't robotic. And open
 * hats that stop at the next closed hat, like a hi-hat's pedal.
 */
import type { BeatNote, BeatSound, BeatTrack } from './spec';
import { GROOVE, guessStyle, type Style } from './style';

const STEPS_PER_BAR = 16;
const EPS = 1e-6;

/** Deterministic noise in [−1, 1) from a string and a number (FNV-1a + an integer mix). */
function jitterNoise(name: string, i: number): number {
  let h = 2166136261;
  for (let k = 0; k < name.length; k++) h = Math.imul(h ^ name.charCodeAt(k), 16777619);
  h = Math.imul(h ^ (i + 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

const isInt = (step: number) => Math.abs(step - Math.round(step)) < EPS;

/** Runs of 3+ notes spaced closer than a 1/16 (rolls), as index lists. */
function rolls(notes: readonly BeatNote[]): number[][] {
  const out: number[][] = [];
  let run: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    const prev = notes[i - 1];
    if (prev && notes[i]!.step - prev.step < 1 - EPS) run.push(i);
    else {
      if (run.length >= 3) out.push(run);
      run = [i];
    }
  }
  if (run.length >= 3) out.push(run);
  return out;
}

const HAT_LIKE: ReadonlySet<BeatSound> = new Set(['hat', 'open-hat', 'rim', 'cowbell']);

/** The velocity a note of `sound` at `step` gets in `style` (before jitter); `main` = a main snare hit. */
function accentFor(sound: BeatSound, step: number, style: Style, main: boolean): number {
  const g = GROOVE[style];
  const pos = ((step % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  switch (sound) {
    case 'kick':
      if (!isInt(step)) return g.kickOff * 0.9;
      if (Math.round(pos) === 0) return g.kickOn;
      return Math.round(pos) % 4 === 0 ? g.kickBeat : g.kickOff;
    case 'snare':
    case 'clap':
      return main ? g.backbeat : g.ghost;
    case 'hat':
    case 'open-hat':
    case 'rim':
    case 'cowbell': {
      const v = g.hat[Math.floor(pos + EPS) % 4] as number;
      return sound === 'open-hat' ? Math.max(v, 0.8) : isInt(step) ? v : v * 0.85;
    }
    case 'crash':
      return 0.9;
    case 'tom-low':
    case 'tom-mid':
    case 'tom-high':
      return 0.85;
    case '808':
      return 0.9;
    default:
      return 0.8;
  }
}

/**
 * Fills the velocities of `track`'s notes marked in `missing` with the style's accents (in place).
 * Notes the AI gave a velocity keep it exactly.
 */
export function applyAccents(track: BeatTrack, missing: readonly boolean[], style: Style): void {
  const notes = track.notes;
  if (!missing.some(Boolean)) return;
  const g = GROOVE[style];
  // Snare/clap main hits: those on a beat, or every whole step when none is (a dembow).
  let mains: Set<number> | null = null;
  if (track.sound === 'snare' || track.sound === 'clap') {
    const onBeat = notes.filter((n) => isInt(n.step) && Math.round(n.step) % 4 === 0).map((n) => n.step);
    mains = new Set(onBeat.length ? onBeat : notes.filter((n) => isInt(n.step)).map((n) => n.step));
  }
  const vel = notes.map((n) => accentFor(track.sound, n.step, style, mains?.has(n.step) ?? false));
  // Rolls rise into what follows: from half the style's top accent to all of it (drums only).
  if (track.sound !== '808' && (HAT_LIKE.has(track.sound) || track.sound === 'snare' || track.sound === 'clap'))
    for (const run of rolls(notes)) {
      const top = track.sound === 'snare' || track.sound === 'clap' ? g.backbeat : Math.max(...g.hat);
      run.forEach((i, k) => (vel[i] = top * (0.5 + (0.5 * k) / (run.length - 1))));
    }
  notes.forEach((n, i) => {
    if (!missing[i]) return;
    const v = (vel[i] as number) + g.jitter * jitterNoise(track.name, i);
    n.vel = Math.round(Math.min(1, Math.max(0.05, v)) * 1000) / 1000;
  });
}

/**
 * Open hats on their own channel stop at the next closed hat (at most 2 steps, or the length the
 * AI gave) and at their own next hit; the beat writer turns the Sampler's envelope on so the note
 * end is heard. `explicitLen[i]` marks the open-hat notes whose length the AI set.
 */
export function chokeOpenHats(
  tracks: readonly BeatTrack[],
  explicitLen: ReadonlyMap<BeatNote, boolean>,
  totalSteps: number,
): void {
  const closed = tracks
    .filter((t) => t.sound === 'hat')
    .flatMap((t) => t.notes.map((n) => n.step))
    .sort((a, b) => a - b);
  for (const t of tracks) {
    if (t.sound !== 'open-hat') continue;
    t.notes.forEach((n, i) => {
      const nextClosed = closed.find((s) => s > n.step + EPS);
      const nextOwn = t.notes[i + 1]?.step;
      const limit = Math.min(
        nextClosed !== undefined ? nextClosed - n.step : Infinity,
        nextOwn !== undefined ? nextOwn - n.step : Infinity,
        totalSteps - n.step,
      );
      const len = explicitLen.get(n) ? (n.len ?? 1) : 2;
      n.len = Math.max(1 / 6, Math.min(len, limit));
    });
  }
}

/** Kicks on all four beats of most bars of a beat ("four on the floor"). */
function fourOnTheFloor(tracks: readonly BeatTrack[], bars: number): boolean {
  const kicks = tracks.filter((t) => t.sound === 'kick');
  if (!kicks.length) return false;
  let four = 0;
  for (let b = 0; b < bars; b++) {
    const beats = new Set(
      kicks.flatMap((t) => t.notes.filter((n) => isInt(n.step) && Math.round(n.step) % 4 === 0).map((n) => Math.round(n.step))),
    );
    if ([0, 4, 8, 12].every((q) => beats.has(b * STEPS_PER_BAR + q))) four++;
  }
  return four / Math.max(1, bars) >= 0.6;
}

/** A best guess at a beat's style from its tempo, swing and kick pattern (when the AI didn't say). */
export function styleOfBeat(tracks: readonly BeatTrack[], bars: number, bpm: number, swing: number): Style {
  return guessStyle(bpm, swing, fourOnTheFloor(tracks, bars));
}
