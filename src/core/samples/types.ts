/** What the sample browser knows about one audio file (the analysis is cached per file, see `cache.ts`). */

/** Bump when the analysis changes: cached results of other versions are dropped and made again. */
export const SAMPLE_ANALYSIS_VERSION = 1;

/** The kinds of one-shot the browser tells apart, in the order the filter chips show them. */
export const SAMPLE_CATEGORIES = [
  'kick',
  'snare',
  'clap',
  'hat',
  'open-hat',
  'cymbal',
  'tom',
  'perc',
  '808',
  'fx',
  'vocal',
  'tonal',
] as const;
export type SampleCategory = (typeof SAMPLE_CATEGORIES)[number];

/** One-shot (a single hit or note), loop (rhythmic, repeating), long (a song or recording: not analyzed in depth). */
export type SampleKind = 'one-shot' | 'loop' | 'long';

export const CATEGORY_LABELS: Readonly<Record<SampleCategory, string>> = {
  kick: 'Kick',
  snare: 'Snare',
  clap: 'Clap',
  hat: 'Hat',
  'open-hat': 'Open hat',
  cymbal: 'Cymbal',
  tom: 'Tom',
  perc: 'Perc',
  '808': '808 / Bass',
  fx: 'FX',
  vocal: 'Vocal',
  tonal: 'Tonal',
};

/** What loops are mostly made of. */
export type LoopKind = 'drums' | 'bass' | 'melodic';

export interface SampleAnalysis {
  /** `SAMPLE_ANALYSIS_VERSION` when it was made. */
  v: number;
  kind: SampleKind;
  durationSec: number;
  /** One-shots: what it is (null for loops and long files). */
  category: SampleCategory | null;
  /** 0..1, how sure the category is (loops: how sure of the tempo). */
  confidence: number;
  /** Loops: tempo (BPM) and length in bars (4/4), when a pulse was found. */
  bpm?: number;
  bars?: number;
  loopKind?: LoopKind;
  /** The key's tonic as a pitch class 0–11 (C = 0): a tonal one-shot's note, or a loop's key. */
  root?: number;
  /** One-shots: the MIDI note it sounds at (60 = C4), fractional. */
  midi?: number;
  /** Loops: major or minor. */
  mode?: 'major' | 'minor';
  /** 0..1 */
  keyConfidence?: number;
  /** Loudness: RMS of the sound while it is audible, dBFS. */
  loudnessDb: number;
  /** Highest sample, dBFS. */
  peakDb: number;
  /** Spectral centroid in Hz: how bright it is. */
  brightness: number;
  /** A short fingerprint for "similar sounds" (see `similarity.ts`). */
  vec: number[];
  /** Where the category came from: the sound itself, the file or folder name, or both agreeing. */
  basis?: 'signal' | 'name' | 'both';
}
