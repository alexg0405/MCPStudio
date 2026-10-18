/**
 * Fit a melody to the chords: notes that land on a strong beat (or last a beat or more) move to the nearest chord tone, the
 * others to the nearest note of the song key's scale. The strength says how many of the notes that are off get fixed, the
 * smallest moves first, so 30% is a light touch and 100% leaves every note on a chord or scale tone (and running it again
 * changes nothing). Pure, no DOM.
 */
import { chordPitchClasses, mod12, type ChordSymbol } from './chord';
import { scalePitchClasses, type KeyLike } from './scale';

export interface MelodyNote {
  tick: number;
  length: number;
  key: number;
}

export interface FitOptions {
  /** The chord sounding at a tick (null: none). */
  chordAt: (tick: number) => ChordSymbol | null;
  key: KeyLike | null;
  /** 0–1: the share of the notes that are off that get fixed. */
  strength: number;
  /** Ticks per beat. */
  beat: number;
  /** Beats per bar (default 4): the strong beats are the first and, in a bar of four, the third. */
  beatsPerBar?: number;
}

export interface FitResult {
  /** The new key of each input note, same order (equal to the old key when it stays). */
  keys: number[];
  /** How many notes moved. */
  moved: number;
  /** How many were off (before the strength decided which to fix). */
  off: number;
}

/** Whether a note starting at `tick` is on a strong beat. */
export function isStrongBeat(tick: number, beat: number, beatsPerBar = 4): boolean {
  const idx = Math.round(tick / beat);
  // On the beat (a 32nd note early or late still counts as the beat: played notes are never exact).
  if (Math.abs(tick - idx * beat) > beat / 8) return false;
  const inBar = ((idx % beatsPerBar) + beatsPerBar) % beatsPerBar;
  return inBar === 0 || (beatsPerBar % 2 === 0 && inBar === beatsPerBar / 2);
}

/** The key with a pitch class in `set` nearest to `key` (ties: the one nearer `lean`, else the lower). */
function nearestIn(key: number, set: ReadonlySet<number>, lean: number): number {
  for (let d = 0; d <= 6; d++) {
    const down = key - d;
    const up = key + d;
    const dn = set.has(mod12(down)) && down >= 0;
    const upOk = set.has(mod12(up)) && up <= 127;
    if (dn && upOk && d > 0) return Math.abs(up - lean) < Math.abs(down - lean) ? up : down;
    if (dn) return down;
    if (upOk) return up;
  }
  return key;
}

export function fitMelody(notes: readonly MelodyNote[], opts: FitOptions): FitResult {
  const scale = opts.key ? new Set(scalePitchClasses(opts.key)) : null;
  const order = notes.map((_, i) => i).sort((a, b) => (notes[a] as MelodyNote).tick - (notes[b] as MelodyNote).tick);
  const keys = notes.map((n) => n.key);
  const wants: { i: number; to: number; dist: number }[] = [];
  let lean = -1;
  for (const i of order) {
    const n = notes[i] as MelodyNote;
    const chord = opts.chordAt(n.tick);
    const strong = !!chord && (isStrongBeat(n.tick, opts.beat, opts.beatsPerBar) || n.length >= opts.beat);
    let target: ReadonlySet<number> | null = null;
    if (strong && chord) target = new Set(chordPitchClasses(chord));
    else if (scale) {
      // A weak note may stay on a chord tone too (a chord can have notes outside the key).
      target = chord ? new Set([...scale, ...chordPitchClasses(chord)]) : scale;
    }
    if (target && !target.has(mod12(n.key))) {
      const to = nearestIn(n.key, target, lean < 0 ? n.key : lean);
      if (to !== n.key) wants.push({ i, to, dist: Math.abs(to - n.key) });
      lean = to;
    } else lean = n.key;
  }
  const strength = Math.max(0, Math.min(1, opts.strength));
  const fix = Math.ceil(wants.length * strength - 1e-9);
  // Smallest moves first; equal moves by time.
  const ranked = [...wants].sort((a, b) => a.dist - b.dist || (notes[a.i] as MelodyNote).tick - (notes[b.i] as MelodyNote).tick);
  for (const w of ranked.slice(0, fix)) keys[w.i] = w.to;
  return { keys, moved: Math.max(0, Math.min(fix, wants.length)), off: wants.length };
}
