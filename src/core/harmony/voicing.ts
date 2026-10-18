/**
 * Voicing a chord progression with voice leading: each chord is laid out as the notes of a hand on a keyboard, and the
 * choice of inversion and octave for every chord is the one that keeps the whole progression moving the least (a dynamic
 * program over the candidate voicings). The notes that two chords share stay where they are. Pure, no DOM.
 */
import { chordPitchClasses, mod12, qualityOf, type ChordSymbol } from './chord';

/** How the notes of one chord sit: stacked tightly, every second note an octave up, or the second from the top dropped. */
export type Spread = 'close' | 'open' | 'drop2';

export interface VoicingOptions {
  /** The middle of the hand: MIDI key (default 60). */
  center?: number;
  spread?: Spread;
  /** The first chord's inversion (0 = root position); `'auto'` (default) lets voice leading pick the nearest to the centre. */
  inversion?: 'auto' | number;
  /** Add the chord's bass (its root, or the slash bass) as a low note under the hand. */
  bass?: boolean;
  /** The lowest key the bass note may be (default 36, C2): it sits in the octave from there. */
  bassLow?: number;
}

const KEY_MIN = 21;
const KEY_MAX = 108;

/** The chord tones as pitch classes in stacking order (root, third, fifth, seventh, ninth…). */
function tonesOf(c: ChordSymbol): number[] {
  return chordPitchClasses(c);
}

/** `pcs` stacked upward from the lowest key `from` with pc `pcs[0]`, each note the nearest above the one below. */
function stack(pcs: readonly number[], from: number): number[] {
  const out = [from];
  for (let i = 1; i < pcs.length; i++) {
    const prev = out[i - 1] as number;
    let k = prev + ((((pcs[i] as number) - prev) % 12) + 12) % 12;
    // A pitch class equal to the one below goes an octave up.
    if (k <= prev) k += 12;
    out.push(k);
  }
  return out;
}

function spreadOut(keys: number[], spread: Spread): number[] {
  const k = [...keys].sort((a, b) => a - b);
  if (spread === 'close' || k.length < 3) return k;
  if (spread === 'open') return k.map((x, i) => (i % 2 === 1 ? x + 12 : x)).sort((a, b) => a - b);
  // drop2
  return k.map((x, i) => (i === k.length - 2 ? x - 12 : x)).sort((a, b) => a - b);
}

const mean = (keys: readonly number[]) => keys.reduce((a, b) => a + b, 0) / Math.max(1, keys.length);

/** One candidate voicing of a chord. */
export interface Candidate {
  keys: number[];
  /** Which inversion it is (0 = the root is the lowest note). */
  inversion: number;
}

/**
 * Every voicing of a chord whose notes are centred near `center`: each inversion at each height that fits. A chord with a
 * slash bass is only voiced with that note lowest (unless the bass is added separately).
 */
export function voicingCandidates(c: ChordSymbol, opts: Pick<VoicingOptions, 'center' | 'spread' | 'bass'> = {}): Candidate[] {
  const center = opts.center ?? 60;
  const spread = opts.spread ?? 'close';
  const tones = tonesOf(c);
  const slashLow = !opts.bass && c.bass !== undefined && mod12(c.bass) !== mod12(c.root) ? mod12(c.bass) : null;
  const out: Candidate[] = [];
  for (let inv = 0; inv < tones.length; inv++) {
    const rotated = [...tones.slice(inv), ...tones.slice(0, inv)];
    if (slashLow !== null && rotated[0] !== slashLow) continue;
    for (let low = center - 14; low <= center + 8; low++) {
      if (mod12(low) !== rotated[0]) continue;
      const keys = spreadOut(stack(rotated, low), spread);
      const lo = keys[0] as number;
      const hi = keys[keys.length - 1] as number;
      if (lo < KEY_MIN || hi > KEY_MAX) continue;
      // The hand stays around the centre.
      if (Math.abs(mean(keys) - center) > 11) continue;
      out.push({ keys, inversion: inv });
    }
  }
  return out;
}

/** Total semitone movement from one voicing to the next: notes pair up in order; unequal hands count the nearest note. */
export function voiceMovement(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length === b.length) {
    const x = [...a].sort((p, q) => p - q);
    const y = [...b].sort((p, q) => p - q);
    let sum = 0;
    for (let i = 0; i < x.length; i++) sum += Math.abs((x[i] as number) - (y[i] as number));
    return sum;
  }
  const nearest = (v: number, set: readonly number[]) => Math.min(...set.map((s) => Math.abs(s - v)));
  let sum = 0;
  for (const v of a) sum += nearest(v, b);
  for (const v of b) sum += nearest(v, a);
  return sum / 2;
}

/** Total movement of a whole sequence of voicings. */
export const totalMovement = (voicings: readonly (readonly number[])[]): number => {
  let sum = 0;
  for (let i = 1; i < voicings.length; i++) sum += voiceMovement(voicings[i - 1] as number[], voicings[i] as number[]);
  return sum;
};

/** The bass note under a chord: its slash bass or root, in the octave from `low`. */
export function bassKeyFor(c: ChordSymbol, low = 36): number {
  const pc = c.bass !== undefined ? mod12(c.bass) : mod12(c.root);
  return low + mod12(pc - low);
}

/**
 * Voices a progression: one ascending list of keys per chord, chosen so the total movement between chords is the smallest
 * possible among the candidates. With `bass` each list starts with the bass note.
 */
export function voiceChords(chords: readonly ChordSymbol[], opts: VoicingOptions = {}): number[][] {
  const center = opts.center ?? 60;
  const sets = chords.map((c, i) => {
    let cands = voicingCandidates(c, { center, spread: opts.spread ?? 'close', bass: opts.bass === true });
    if (i === 0 && typeof opts.inversion === 'number') {
      const want = cands.filter((x) => x.inversion === opts.inversion);
      if (want.length) cands = want;
    }
    if (cands.length === 0) cands = [{ keys: [center + mod12(c.root - center)], inversion: 0 }];
    return cands;
  });
  // cost[i][j]: cheapest way to end chord i on candidate j; a small pull toward the centre breaks ties.
  const pull = (keys: number[]) => Math.abs(mean(keys) - center) * 0.15;
  const cost: number[][] = [];
  const from: number[][] = [];
  sets.forEach((cands, i) => {
    if (i === 0) {
      cost.push(cands.map((candidate) => pull(candidate.keys)));
      from.push(cands.map(() => -1));
      return;
    }
    const prev = sets[i - 1] as Candidate[];
    const prevCost = cost[i - 1] as number[];
    const row: number[] = [];
    const back: number[] = [];
    for (const cand of cands) {
      let best = Infinity;
      let arg = 0;
      prev.forEach((p, j) => {
        const v = (prevCost[j] as number) + voiceMovement(p.keys, cand.keys);
        if (v < best) {
          best = v;
          arg = j;
        }
      });
      row.push(best + pull(cand.keys));
      back.push(arg);
    }
    cost.push(row);
    from.push(back);
  });
  const result: number[][] = [];
  if (sets.length === 0) return result;
  let j = 0;
  const last = cost[cost.length - 1] as number[];
  for (let k = 1; k < last.length; k++) if ((last[k] as number) < (last[j] as number)) j = k;
  for (let i = sets.length - 1; i >= 0; i--) {
    result[i] = [...((sets[i] as Candidate[])[j] as Candidate).keys];
    j = (from[i] as number[])[j] as number;
  }
  if (opts.bass)
    return result.map((keys, i) => {
      const b = bassKeyFor(chords[i] as ChordSymbol, opts.bassLow ?? 36);
      return [b, ...keys.filter((k) => k !== b)];
    });
  return result;
}

/** What a chord looks like with no voice leading: root position stacked from the root nearest below the centre. */
export function naiveVoicing(c: ChordSymbol, center = 60): number[] {
  const base = center - 12 + mod12(c.root - (center - 12));
  return qualityOf(c.quality).intervals.map((i) => base + i);
}

/** How a held chord is played: held for its whole length, struck on every beat, on the off-beat eighths, or every eighth. */
export type CompRhythm = 'hold' | 'beats' | 'offbeats' | 'eighths';
export const COMP_RHYTHMS: readonly CompRhythm[] = ['hold', 'beats', 'offbeats', 'eighths'];

export interface CompNote {
  tick: number;
  length: number;
  key: number;
  velocity: number;
}

/**
 * Notes for a progression: `chords` say where each chord starts and how long it lasts, `voicings` the keys of each. The
 * rhythm decides the strikes inside a chord (restarting at every chord change); `beat` is ticks per beat.
 */
export function compNotes(
  chords: readonly { tick: number; length: number }[],
  voicings: readonly (readonly number[])[],
  opts: { rhythm?: CompRhythm; beat: number; velocity?: number; gate?: number },
): CompNote[] {
  const rhythm = opts.rhythm ?? 'hold';
  const velocity = opts.velocity ?? 0.8;
  const gate = opts.gate ?? 0.95;
  const out: CompNote[] = [];
  chords.forEach((c, i) => {
    const keys = voicings[i];
    if (!keys) return;
    const step = rhythm === 'hold' ? c.length : rhythm === 'beats' ? opts.beat : opts.beat / 2;
    const offset = rhythm === 'offbeats' ? opts.beat / 2 : 0;
    const every = rhythm === 'offbeats' ? opts.beat : step;
    for (let t = offset; t < c.length - 1; t += every) {
      const len = Math.max(1, Math.min(rhythm === 'hold' ? c.length : step, c.length - t));
      for (const key of keys)
        out.push({ tick: Math.round(c.tick + t), length: Math.max(1, Math.round(len * (rhythm === 'hold' ? 1 : gate))), key, velocity });
    }
  });
  return out;
}
