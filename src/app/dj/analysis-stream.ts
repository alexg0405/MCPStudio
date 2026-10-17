/**
 * One track analysis from a song read in pieces (Worker-safe: no DOM; the analysis Worker runs it, and so does the main
 * thread where there is no Worker). It is the whole-file analysis (`analysis-run.ts`) with nothing ever held whole:
 *
 *  1. `scanChunk` the level scan: regions of the song, to measure the level the onset and chroma stages scale by.
 *  2. `begin`, then `push` every chunk of the file in order: loudness and true peak (`LoudnessStream`) and the onset and
 *     chroma features (`StreamFeatures`) are made as the audio goes by and the audio is forgotten.
 *  3. `finish`: tempo, beats, bars, key, energy, sections and mix points from the features (`analyzeFeatures`).
 *
 * Memory is the features of the song (a few tens of MB for two hours at 22 kHz) plus the chunk being worked on.
 */
import { analyzeFeatures } from '@core/dj/analyze';
import { LevelScan, StreamFeatures, type Levels } from '@core/dj/stream-features';
import type { TrackAnalysis } from '@core/dj/types';
import { LoudnessStream } from './analysis-run';

/** What the analysis needs to know about the file before the first chunk. */
export interface StreamInfo {
  hash: string;
  /** The file's own rate and length in frames. */
  sampleRate: number;
  frames: number;
  channels: 1 | 2;
}

export class StreamingAnalysis {
  private readonly scan: LevelScan;
  private levels: Levels | null = null;
  private features: StreamFeatures | null = null;
  private loud: LoudnessStream | null = null;
  private pushed = 0;
  private finished = false;

  constructor(readonly info: StreamInfo) {
    this.scan = new LevelScan(info.sampleRate);
  }

  /** A new region of the level scan starts with the next `scanChunk`. */
  startScanRegion(): void {
    this.scan.startRegion();
  }

  scanChunk(l: Float32Array, r: Float32Array | null): void {
    this.scan.push(l, r);
  }

  /** The scan is over; the next chunks are the song from its first frame. */
  begin(): void {
    this.levels = this.scan.result();
    this.features = new StreamFeatures(this.info.sampleRate, this.levels, this.info.frames);
    this.loud = new LoudnessStream(this.info.sampleRate, this.info.channels > 1);
  }

  push(l: Float32Array, r: Float32Array | null): void {
    if (!this.features || !this.loud) this.begin();
    this.loud!.push(l, r);
    this.features!.push(l, r);
    this.pushed += l.length;
  }

  /** Frames pushed so far. */
  get framesDone(): number {
    return this.pushed;
  }

  finish(opts: { onProgress?(fraction: number): void; isCancelled?(): boolean } = {}): TrackAnalysis {
    if (this.finished) throw new Error('The analysis is finished.');
    if (!this.features || !this.loud) this.begin();
    if (this.pushed === 0) throw new Error('There was no audio to analyze.');
    const { lufs, truePeakDb } = this.loud!.finish();
    const { features, chroma } = this.features!.finish();
    // What made the features is not needed any more.
    this.features = null;
    this.loud = null;
    this.finished = true;
    const durationSec = this.pushed / this.info.sampleRate;
    return analyzeFeatures(features, chroma, { hash: this.info.hash, durationSec, lufs, truePeakDb }, opts);
  }
}
