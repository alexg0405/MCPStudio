import { hzToMidi } from '../pitch';

/** The pitch track at a fixed frame spacing. */
export interface PitchFrames {
  /** Time (seconds, on the timeline of the recording) of frame 0's centre. */
  t0: number;
  /** Seconds between frames. */
  hop: number;
  /** Fundamental in Hz per frame; 0 where unvoiced. */
  f0: Float32Array;
  /** 0..1 how periodic each frame is. */
  conf: Float32Array;
}

export interface PitchNote {
  /** Seconds on the recording's timeline. */
  from: number;
  to: number;
  /** The pitch it was sung at: the median, as a MIDI note (60 = C4, fractions are cents). */
  pitch: number;
  /** How far its slow pitch line wanders from start to end, cents (peak to peak). */
  drift: number;
  /** Vibrato depth in cents, peak to peak (0 when there is none). */
  vibratoDepth: number;
  /** Vibrato rate in Hz (0 when there is none). */
  vibratoRate: number;
}

export const PITCH_NOTE_THRESHOLDS = {
  /** A note ends when the pitch is this far (cents) from its centre and settles elsewhere. */
  splitCents: 65,
  /** The new level must hold this long (seconds). */
  settleSec: 0.05,
  /** Unvoiced gaps this long end a note (seconds). */
  gapSec: 0.03,
  /** A piece shorter than this joins its neighbour (seconds of pitched sound). */
  minPieceSec: 0.04,
  /** Notes with less pitched sound than this are dropped. */
  minNoteSec: 0.03,
  /** The slow pitch line is a moving average this long (about one vibrato period), seconds. */
  slowSec: 0.17,
  /** Vibrato needs at least this depth (cents, peak to peak) and a rate in this range (Hz). */
  vibratoMinDepth: 25,
  vibratoRate: [3.5, 9.5] as const,
};

/** A frequency in Hz as cents above MIDI note 0 (100 per semitone); NaN for an unvoiced (0 Hz) frame. */
export const centsOf = (hz: number) => (hz > 0 ? 100 * hzToMidi(hz) : Number.NaN);

/** Cents back to a frequency in Hz. */
export const hzOf = (cents: number) => 440 * Math.pow(2, (cents / 100 - 69) / 12);

/** The median (the mean of the middle two for an even count); NaN for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : 0.5 * ((s[m - 1] as number) + (s[m] as number));
}

/** Cents of every frame (NaN where unvoiced). */
export function framesToCents(f0: Float32Array): Float64Array {
  const c = new Float64Array(f0.length);
  for (let i = 0; i < f0.length; i++) c[i] = centsOf(f0[i] as number);
  return c;
}
