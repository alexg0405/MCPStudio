/**
 * The features of a song that arrives in pieces (pure, no DOM; the app runs it in the analysis Worker): what `analyzeTrack`
 * makes from one mono signal in memory, made from chunks of the file's own audio with bounded memory.
 *
 *  - `AnalysisFront`: stereo at the file's rate → mono at about 22 kHz (the same signal `analysisSignal` makes).
 *  - `LevelScan`: the onset and chroma stages scale their compression by the song's overall level, which a stream can't
 *    know before it has heard everything. It is measured first, on regions of the song spread over its length
 *    (the whole song when it is short: then it is exactly what the whole-file analysis measures).
 *  - `StreamFeatures`: front → `OnsetStream` and `ChromaStream`; `finish()` gives the features the rest of the analysis
 *    (`analyzeFeatures`: tempo, beats, bars, key, energy, sections) reads, a few tens of MB for a 2-hour song.
 */
import { Decimator } from '../voice/filters';
import { ChromaLevel, ChromaStream, type Chromagram } from './chroma';
import { OnsetStream, type OnsetFeatures } from './onset';

/** The analysis rate is an integer fraction of the file's: about 22 kHz (as `analysisSignal` does). */
export const analysisFactor = (sourceRate: number): number => Math.max(1, Math.round(sourceRate / 22050));

/** Mono at about 22 kHz from stereo (or mono) chunks at the file's rate, a chunk at a time with the filter state carried over. */
export class AnalysisFront {
  readonly factor: number;
  readonly rate: number;
  private readonly dec: Decimator | null;
  private mix = new Float32Array(0);
  private out = new Float32Array(0);

  constructor(sourceRate: number) {
    this.factor = analysisFactor(sourceRate);
    this.rate = sourceRate / this.factor;
    this.dec = this.factor > 1 ? new Decimator(this.factor, sourceRate) : null;
  }

  /** The mono signal for the next `l.length` frames (`r`: the right channel, or null for a mono file). Valid until the next call. */
  push(l: Float32Array, r: Float32Array | null): Float32Array {
    const n = l.length;
    let mono: Float32Array = l;
    if (r) {
      if (this.mix.length < n) this.mix = new Float32Array(n);
      const m = this.mix;
      // The same float32 steps as `analysisSignal`: left + right rounded, then halved.
      for (let i = 0; i < n; i++) m[i] = l[i]! + r[i]!;
      for (let i = 0; i < n; i++) m[i] = m[i]! / 2;
      mono = m.subarray(0, n);
    }
    if (!this.dec) return mono;
    const need = this.dec.outputLength(n);
    if (this.out.length < need) this.out = new Float32Array(need);
    const k = this.dec.process(mono, this.out, n);
    return this.out.subarray(0, k);
  }
}

export interface Levels {
  /** Root mean square of the mono analysis signal, and of it at half the rate (the chroma's own). */
  onsetRms: number;
  chromaRms: number;
}

/** A stretch of the file read for the level scan: source frames [start, start + frames). */
export interface ScanRegion {
  start: number;
  frames: number;
}

/**
 * Where the level scan reads: the whole song when it is no longer than `budgetSec`, else regions of `regionSec` seconds
 * centred in equal shares of the song (so a 2-hour mix is sampled through its whole length: about 2 % of it).
 */
export function planScanRegions(frames: number, sampleRate: number, budgetSec = 600, regionSec = 20): ScanRegion[] {
  if (frames <= budgetSec * sampleRate) return frames > 0 ? [{ start: 0, frames }] : [];
  const count = Math.max(1, Math.floor(budgetSec / regionSec));
  const span = frames / count;
  const len = Math.round(regionSec * sampleRate);
  const regions: ScanRegion[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.max(0, Math.min(frames - len, Math.round(i * span + (span - len) / 2)));
    regions.push({ start, frames: len });
  }
  return regions;
}

/** The levels, measured over regions of the song (each region fed through a fresh front end, in order). */
export class LevelScan {
  private front: AnalysisFront;
  private chroma: ChromaLevel;
  private sq = 0;
  private n = 0;
  private chromaSq = 0;
  private chromaN = 0;

  constructor(private readonly sourceRate: number) {
    this.front = new AnalysisFront(sourceRate);
    this.chroma = new ChromaLevel(this.front.rate);
  }

  /** The next chunk belongs to a new region (the filters start again). */
  startRegion(): void {
    this.flush();
    this.front = new AnalysisFront(this.sourceRate);
  }

  push(l: Float32Array, r: Float32Array | null): void {
    const mono = this.front.push(l, r);
    for (let i = 0; i < mono.length; i++) this.sq += mono[i]! * mono[i]!;
    this.n += mono.length;
    this.chroma.push(mono);
  }

  private flush(): void {
    this.chromaSq += this.chroma.sumSquares;
    this.chromaN += this.chroma.count;
    this.chroma = new ChromaLevel(this.front.rate);
  }

  result(): Levels {
    this.flush();
    return {
      onsetRms: Math.sqrt(this.sq / Math.max(1, this.n)),
      chromaRms: Math.sqrt(this.chromaSq / Math.max(1, this.chromaN)),
    };
  }
}

/** The onset features and chromagram of a song fed in chunks. */
export class StreamFeatures {
  readonly rate: number;
  private readonly front: AnalysisFront;
  private readonly onset: OnsetStream;
  private readonly chroma: ChromaStream;

  constructor(sourceRate: number, levels: Levels, expectedFrames = 0) {
    this.front = new AnalysisFront(sourceRate);
    this.rate = this.front.rate;
    const expected = Math.ceil(expectedFrames / this.front.factor);
    this.onset = new OnsetStream(this.rate, levels.onsetRms, expected);
    this.chroma = new ChromaStream(this.rate, levels.chromaRms, expected);
  }

  push(l: Float32Array, r: Float32Array | null): void {
    const mono = this.front.push(l, r);
    this.onset.push(mono);
    this.chroma.push(mono);
  }

  finish(): { features: OnsetFeatures; chroma: Chromagram } {
    return { features: this.onset.finish(), chroma: this.chroma.finish() };
  }
}
