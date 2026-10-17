/**
 * Hand-made track analyses for tests and demos (what the analyzer would say about a song with a
 * known grid): a steady grid, a key, phrase-long sections and mix points on phrase starts.
 */
import { ANALYSIS_VERSION, type TrackAnalysis, type TrackKey } from './types';
import { camelotOf } from './wheel';

export interface FakeSong {
  bpm: number;
  /** Tonic 0–11 and mode, or null for no key. */
  key?: { root: number; mode: 'major' | 'minor'; confidence?: number } | null;
  /** Length in bars (4/4) after the first downbeat; default 96. */
  bars?: number;
  firstDownbeat?: number;
  /** Mix-in and mix-out in bars from the first downbeat; default 0 and bars − 32. */
  mixInBar?: number;
  mixOutBar?: number;
  lufs?: number;
  /** Energy per bar (default: an arc with a drop in the middle). */
  energy?: number[];
  hash?: string;
  gridConfidence?: number;
  noGrid?: boolean;
  /** Tracked beat times (seconds) for a song whose tempo drifts; `bpm` is then its average. */
  beats?: number[];
}

export function fakeKey(root: number, mode: 'major' | 'minor', confidence = 0.8): TrackKey {
  return { root, mode, camelot: camelotOf(root, mode), confidence };
}

export function fakeAnalysis(s: FakeSong): TrackAnalysis {
  const bars = s.bars ?? 96;
  const f = s.firstDownbeat ?? 0;
  const barSec = (4 * 60) / s.bpm;
  const at = (bar: number) => f + bar * barSec;
  const energy =
    s.energy ?? Array.from({ length: bars }, (_, i) => (i < 16 ? 0.35 : i < bars - 16 ? (i % 32 < 16 ? 0.85 : 0.6) : 0.4));
  const mixOutBar = s.mixOutBar ?? Math.max(16, bars - 32);
  return {
    version: ANALYSIS_VERSION,
    hash: s.hash ?? `fake-${s.bpm}-${s.key ? `${s.key.root}${s.key.mode}` : 'nokey'}-${bars}`,
    durationSec: at(bars),
    grid: s.noGrid
      ? null
      : { bpm: s.bpm, firstDownbeat: f, beatsPerBar: 4, confidence: s.gridConfidence ?? (s.beats ? 0.4 : 0.95), beats: s.beats ?? [] },
    key: s.key ? fakeKey(s.key.root, s.key.mode, s.key.confidence) : null,
    lufs: s.lufs ?? -9,
    truePeakDb: -0.5,
    energy,
    sections: [
      { start: at(0), end: at(16), energy: 0.35, kind: 'intro' },
      { start: at(16), end: at(bars - 16), energy: 0.8, kind: 'body' },
      { start: at(bars - 16), end: at(bars), energy: 0.4, kind: 'outro' },
    ],
    mixIn: at(s.mixInBar ?? 0),
    mixOut: at(mixOutBar),
  };
}
