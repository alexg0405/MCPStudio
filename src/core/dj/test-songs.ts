/**
 * Synthetic songs with known beats, downbeats, key and sections, for the track-analysis tests
 * (unit tests in Node and the browser test). Drums (kick, snare, hats), a bass and chord pads,
 * arranged in parts that switch instruments on and off, with optional swing, a leading silence,
 * a pickup before the first bar and a slow tempo drift. Deterministic (seeded noise).
 */
import { mulberry32 } from '../voice/test-signals';

/** Where drum hits fall in a bar. */
export interface DrumPattern {
  /** Hit positions in beats within one bar (0 ≤ x < beatsPerBar). */
  kick: readonly number[];
  snare: readonly number[];
  hat: readonly number[];
  /** Where offbeat 8ths land within their beat: 0.5 = straight (default), ~0.62–0.67 = swung. */
  swing?: number;
}

/** One part of a test song (a number of bars with some instruments on). */
export interface SongPart {
  bars: number;
  kick?: boolean;
  snare?: boolean;
  hats?: boolean;
  bass?: boolean;
  pads?: boolean;
  /** Overall level of the part (default 1). */
  level?: number;
  /** A crash on the part's first downbeat. */
  crash?: boolean;
}

/** A chord of a test song. */
export interface Chord {
  /** MIDI note of the chord's root (the bass plays it an octave or two down). */
  root: number;
  /** Semitones above the root, e.g. [0, 4, 7] major, [0, 3, 7] minor. */
  notes: readonly number[];
}

/** Everything a test song is made from. */
export interface TestSongSpec {
  sampleRate: number;
  bpm: number;
  /** Tempo at the end (linear drift in beats from `bpm`); default: no drift. */
  endBpm?: number;
  /** Seconds before the first downbeat (silence, or the pickup). */
  offset?: number;
  beatsPerBar?: number;
  pattern: DrumPattern;
  parts: readonly SongPart[];
  /** One chord per bar (cycled); default A minor triad. */
  chords?: readonly Chord[];
  /** Snare hits on the last two beats before the first downbeat. */
  pickup?: boolean;
  /** Bass hits in beats within a bar (default: beats 0 and 2). */
  bassHits?: readonly number[];
  /** Seconds of silence after the last bar. */
  tail?: number;
  /** Detunes the pads and bass (cents from A = 440 Hz). */
  tuningCents?: number;
  seed?: number;
}

/** A rendered test song and the truth about it (where its beats and parts are). */
export interface TestSong {
  mono: Float32Array;
  sampleRate: number;
  /** True times (seconds) of every beat and every downbeat from the first bar on. */
  beats: number[];
  downbeats: number[];
  /** Start time of each part (seconds). */
  partStarts: number[];
  durationSec: number;
}

/** Common chords as MIDI roots around C4. */
export const MAJOR = [0, 4, 7] as const;
/** The notes of a minor triad above its root (semitones). */
export const MINOR = [0, 3, 7] as const;
/** A chord from its root and notes. */
export const chord = (root: number, notes: readonly number[]): Chord => ({ root, notes });

function oneShot(kind: 'kick' | 'snare' | 'hat' | 'crash', sr: number, seed: number): Float32Array {
  const len = Math.round({ kick: 0.35, snare: 0.2, hat: 0.06, crash: 1.2 }[kind] * sr);
  const out = new Float32Array(len);
  const rand = mulberry32(seed);
  let phase = 0;
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    if (kind === 'kick') {
      const f = 48 + 110 * Math.exp(-t / 0.03);
      phase += (2 * Math.PI * f) / sr;
      out[i] = Math.sin(phase) * Math.exp(-t / 0.09) + (t < 0.003 ? 0.3 * (rand() * 2 - 1) : 0);
    } else if (kind === 'snare') {
      phase += (2 * Math.PI * 190) / sr;
      out[i] = 0.5 * Math.sin(phase) * Math.exp(-t / 0.04) + 0.6 * (rand() * 2 - 1) * Math.exp(-t / 0.06);
    } else {
      // Hats and crash: white noise, differentiated twice (a high-pass).
      const n = rand() * 2 - 1;
      const d = n - h1 - (h1 - h2);
      h2 = h1;
      h1 = n;
      out[i] = 0.25 * d * Math.exp(-t / (kind === 'hat' ? 0.012 : 0.35));
    }
  }
  return out;
}

function add(out: Float32Array, src: Float32Array, at: number, gain: number): void {
  const a = Math.round(at);
  for (let i = 0; i < src.length; i++) {
    const j = a + i;
    if (j >= 0 && j < out.length) out[j] = out[j]! + gain * src[i]!;
  }
}

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Adds a soft tone (a few harmonics) from t0 to t1 seconds. */
function tone(out: Float32Array, sr: number, midi: number, t0: number, t1: number, gain: number, harmonics: readonly number[]): void {
  const f = midiHz(midi);
  const a = Math.max(0, Math.round(t0 * sr));
  const b = Math.min(out.length, Math.round(t1 * sr));
  const attack = 0.02 * sr;
  const release = 0.03 * sr;
  for (let i = a; i < b; i++) {
    const env = Math.min(1, (i - a) / attack, (b - i) / release);
    const t = (i - a) / sr;
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) v += harmonics[h]! * Math.sin(2 * Math.PI * f * (h + 1) * t);
    out[i] = out[i]! + gain * env * v;
  }
}

/** Renders a test song (mono, peak about 0.9). */
export function renderTestSong(spec: TestSongSpec): TestSong {
  const sr = spec.sampleRate;
  const perBar = spec.beatsPerBar ?? 4;
  const offset = spec.offset ?? 0;
  const totalBars = spec.parts.reduce((n, p) => n + p.bars, 0);
  const totalBeats = totalBars * perBar;
  const b0 = spec.bpm;
  const b1 = spec.endBpm ?? spec.bpm;
  const slope = (b1 - b0) / totalBeats;
  // Seconds of beat position x (beats from the first downbeat; negative = the pickup).
  const timeOf = (x: number) =>
    offset + (Math.abs(slope) < 1e-12 ? (60 * x) / b0 : (60 / slope) * Math.log((b0 + slope * x) / b0));
  const tail = spec.tail ?? 1;
  const durationSec = timeOf(totalBeats) + tail;
  const out = new Float32Array(Math.ceil(durationSec * sr));
  const seed = spec.seed ?? 7;
  const kick = oneShot('kick', sr, seed);
  const snare = oneShot('snare', sr, seed + 1);
  const hat = oneShot('hat', sr, seed + 2);
  const crash = oneShot('crash', sr, seed + 3);
  const swing = spec.pattern.swing ?? 0.5;
  const swung = (x: number) => {
    const beat = Math.floor(x);
    const frac = x - beat;
    return Math.abs(frac - 0.5) < 1e-9 ? beat + swing : x;
  };
  const chords = spec.chords ?? [chord(57, MINOR)];
  const tune = (spec.tuningCents ?? 0) / 100;
  const bassHits = spec.bassHits ?? [0, 2];
  const beats: number[] = [];
  const downbeats: number[] = [];
  const partStarts: number[] = [];
  const rand = mulberry32(seed + 9);
  if (spec.pickup) {
    add(out, snare, timeOf(-2) * sr, 0.7);
    add(out, snare, timeOf(-1) * sr, 0.8);
    add(out, snare, timeOf(-0.5) * sr, 0.9);
  }
  let bar = 0;
  for (const part of spec.parts) {
    partStarts.push(timeOf(bar * perBar));
    const level = part.level ?? 1;
    for (let pb = 0; pb < part.bars; pb++, bar++) {
      const x0 = bar * perBar;
      downbeats.push(timeOf(x0));
      for (let k = 0; k < perBar; k++) beats.push(timeOf(x0 + k));
      // Slight velocity variation so the hits aren't identical.
      const vel = () => level * (0.85 + 0.15 * rand());
      if (part.kick) for (const x of spec.pattern.kick) add(out, kick, timeOf(x0 + swung(x)) * sr, 0.9 * vel());
      if (part.snare) for (const x of spec.pattern.snare) add(out, snare, timeOf(x0 + swung(x)) * sr, 0.7 * vel());
      if (part.hats) for (const x of spec.pattern.hat) add(out, hat, timeOf(x0 + swung(x)) * sr, 0.6 * vel());
      if (part.crash && pb === 0) add(out, crash, timeOf(x0) * sr, 0.5 * level);
      const c = chords[bar % chords.length]!;
      if (part.pads)
        for (const n of c.notes) tone(out, sr, c.root + n + tune, timeOf(x0), timeOf(x0 + perBar), 0.07 * level, [1, 0.45, 0.2, 0.1]);
      if (part.bass) {
        const root = c.root - 24 + (c.root - 24 < 33 ? 12 : 0);
        for (let h = 0; h < bassHits.length; h++) {
          const x = bassHits[h]!;
          const next = bassHits[h + 1] ?? perBar;
          tone(out, sr, root + tune, timeOf(x0 + x), timeOf(x0 + next) - 0.02, 0.25 * level, [1, 0.3]);
        }
      }
    }
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i]! * 0.9) / peak;
  return { mono: out, sampleRate: sr, beats, downbeats, partStarts, durationSec };
}

/** Drum patterns of common styles (positions in beats of a 4/4 bar at the style's tempo). */
export const PATTERNS = {
  /** House / techno: four on the floor, claps on 2 and 4, offbeat open hats. */
  house: { kick: [0, 1, 2, 3], snare: [1, 3], hat: [0.5, 1.5, 2.5, 3.5] },
  /** Boom bap: kick on 1 and the "and" of 2, snare on 2 and 4, 8th hats (swing it). */
  boomBap: { kick: [0, 1.75, 2.5], snare: [1, 3], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
  /** Trap at its 140 BPM: half-time kick and snare (snare on 3), 8th and 16th hats. */
  trap: { kick: [0, 1.75, 2.75], snare: [2], hat: [0, 0.5, 1, 1.5, 2, 2.25, 2.5, 3, 3.5, 3.75] },
  /** Drum and bass two-step at 174: kick on 1 and the "and" of 3, snare on 2 and 4, 8th hats. */
  dnb: { kick: [0, 2.5], snare: [1, 3], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
  /** Reggaeton dembow at 100: kick on every beat, snare on the "a" of 1 and the "and" of 2 (3+3+2). */
  dembow: { kick: [0, 1, 2, 3], snare: [0.75, 1.5, 2.75, 3.5], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
  /** Pop / R&B backbeat: kick 1 and 3, snare 2 and 4, 8th hats. */
  pop: { kick: [0, 2, 2.5], snare: [1, 3], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] },
  /** A waltz (3/4): kick on 1, snares on 2 and 3. */
  waltz: { kick: [0], snare: [1, 2], hat: [0, 0.5, 1, 1.5, 2, 2.5] },
} satisfies Record<string, DrumPattern>;
