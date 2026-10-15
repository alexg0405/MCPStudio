/**
 * The whole track analysis on a mono signal at an analysis rate (~22 kHz): beats and tempo, bars,
 * key, energy, sections and mix points. Loudness (LUFS, true peak) is measured by the caller on the
 * full-rate stereo audio and passed in. Pure and synchronous (the app runs it in a Worker).
 */
import { ANALYSIS_VERSION, type BeatGrid, type TrackAnalysis } from './types';
import { chromagram } from './chroma';
import { barPhase } from './downbeat';
import { estimateKey } from './key';
import { onsetFeatures } from './onset';
import { analyzeStructure } from './structure';
import { trackBeats } from './tempo';

export interface AnalysisInput {
  hash: string;
  /** Mono audio at `sampleRate` (16–24 kHz works best; the app sends 22.05 kHz). */
  mono: Float32Array;
  sampleRate: number;
  /** Seconds (default: the mono signal's length). */
  durationSec?: number;
  lufs: number;
  truePeakDb: number;
}

export interface AnalysisRunOptions {
  /** 0–1 as the analysis goes. */
  onProgress?(fraction: number): void;
  /** Checked between stages: true stops with an AbortError. */
  isCancelled?(): boolean;
}

export class AnalysisCancelled extends Error {
  override name = 'AbortError';
}

export function analyzeTrack(input: AnalysisInput, opts: AnalysisRunOptions = {}): TrackAnalysis {
  const { mono, sampleRate } = input;
  const durationSec = input.durationSec ?? mono.length / sampleRate;
  const progress = (a: number, b: number) => (f: number) => opts.onProgress?.(a + (b - a) * f);
  const check = () => {
    if (opts.isCancelled?.()) throw new AnalysisCancelled('The analysis was cancelled.');
  };
  const f = onsetFeatures(mono, sampleRate, progress(0, 0.45));
  check();
  const c = chromagram(mono, sampleRate, progress(0.45, 0.7));
  check();
  const track = trackBeats(f);
  opts.onProgress?.(0.9);
  check();
  const key = estimateKey(c);

  let grid: BeatGrid | null = null;
  const bounds: number[] = [];
  if (track) {
    const phase = barPhase(f, c, track.beats);
    const perBar = phase.beatsPerBar;
    if (track.drift) {
      for (let i = phase.first; i < track.beats.length; i += perBar) bounds.push(track.beats[i]!);
      const last = bounds[bounds.length - 1];
      const barLen = perBar * (60 / track.bpm);
      if (last !== undefined) bounds.push(Math.min(durationSec, last + barLen));
    } else {
      const p = track.period;
      const barLen = perBar * p;
      const tb = track.beats[phase.first]!;
      let first = track.origin + Math.round((tb - track.origin) / p) * p;
      while (first < 0) first += barLen;
      for (let t = first; t < durationSec - 0.5 * barLen; t += barLen) bounds.push(t);
      const last = bounds[bounds.length - 1];
      if (last !== undefined) bounds.push(Math.min(durationSec, last + barLen));
    }
    if (bounds.length >= 2)
      grid = {
        bpm: track.bpm,
        firstDownbeat: round3(bounds[0]!),
        beatsPerBar: perBar,
        confidence: track.confidence,
        beats: track.drift ? track.beats.map(round3) : [],
      };
  }
  if (!grid) {
    bounds.length = 0;
    for (let t = 0; t < durationSec; t += 2) bounds.push(t);
    bounds.push(durationSec);
  }
  const s = analyzeStructure(f, c, bounds, durationSec);
  opts.onProgress?.(1);
  return {
    version: ANALYSIS_VERSION,
    hash: input.hash,
    durationSec,
    grid,
    key,
    lufs: input.lufs,
    truePeakDb: input.truePeakDb,
    energy: s.energy,
    sections: s.sections.map((x) => ({ ...x, start: round3(x.start), end: round3(x.end) })),
    mixIn: round3(s.mixIn),
    mixOut: round3(s.mixOut),
  };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
