/**
 * Analyzing a song that is too long to decode whole (main-thread side). The file is read by parts the way a deck reads it
 * (`engine/deck/deck-source`: WAV straight from the bytes, MP3 decoded a few seconds at a time through `decodeAudioData`,
 * which Workers don't have) and handed on in chunks of the file's own audio to a `StreamTarget`: the analysis Worker, or
 * the same code on this thread. Nothing is held but a few chunks in flight: the Worker acknowledges each one, and the
 * next is read only when fewer than `MAX_IN_FLIGHT` are waiting.
 */
import { LONG_SONG_SEC } from '@core/dj/long';
import { planScanRegions } from '@core/dj/stream-features';
import type { TrackAnalysis } from '@core/dj/types';
import type { SampleRef } from '@core/model/types';
import { blobReader, openSegmentSource, type DeckSource } from '@engine/deck/deck-source';
import type { SampleBytesProvider } from '@engine/api';
import { yieldToMain } from '@engine/audio-buffers';
import { opfsSampleProvider } from '../persistence/project-io';
import { StreamingAnalysis, type StreamInfo } from './analysis-stream';

/** A file read by parts at its own rate (a deck source, or a stand-in in tests). */
export type StreamSource = Pick<DeckSource, 'nativeFrames' | 'nativeRate' | 'channels' | 'readNative' | 'dispose'>;

/** Where chunks go. Each call resolves when the receiver can take more. */
export interface StreamTarget {
  start(info: StreamInfo): void;
  startRegion(): void;
  scan(l: Float32Array, r: Float32Array | null): Promise<void>;
  chunk(l: Float32Array, r: Float32Array | null): Promise<void>;
  /** Waits for what is in flight, runs the rest of the analysis and returns it. */
  finish(onProgress: (fraction: number) => void): Promise<TrackAnalysis>;
}

/** Frames per chunk (5.9 s at 44.1 kHz: 2 MB of stereo floats). */
export const CHUNK_FRAMES = 1 << 18;
/** Seconds of the song the level scan reads in all. */
export const SCAN_BUDGET_SEC = 600;
/** How long (seconds) each region the level scan reads is. */
export const SCAN_REGION_SEC = 20;
/** The share of the progress bar for the level scan, the pass over the song, and what is left for the tempo and structure. */
const SCAN_SHARE = 0.03;
const PASS_END = 0.93;

/** How to drive an analysis of a song read by parts: when to stop, where to report progress and how big the pieces are. */
export interface DriveOptions {
  signal?: AbortSignal;
  onProgress?(fraction: number): void;
  chunkFrames?: number;
  scanBudgetSec?: number;
  scanRegionSec?: number;
}

/** Reads `source` in chunks into `target` and returns the analysis. Rejects with AbortError when `signal` aborts. */
export async function driveAnalysis(hash: string, source: StreamSource, target: StreamTarget, o: DriveOptions = {}): Promise<TrackAnalysis> {
  const frames = source.nativeFrames;
  const rate = source.nativeRate;
  const stereo = source.channels === 2;
  const chunk = o.chunkFrames ?? CHUNK_FRAMES;
  // At most a couple of hundred reports (the library redraws on each).
  let reported = -1;
  const progress = (f: number) => {
    if (f - reported < 0.005 && f < 1) return;
    reported = f;
    o.onProgress?.(f);
  };
  const read = async (start: number, n: number): Promise<[Float32Array, Float32Array | null]> => {
    o.signal?.throwIfAborted();
    const l = new Float32Array(n);
    // A mono file is read once: the same array stands in for both channels.
    const r = stereo ? new Float32Array(n) : l;
    await source.readNative(start, n, l, r);
    o.signal?.throwIfAborted();
    return [l, stereo ? r : null];
  };
  target.start({ hash, sampleRate: rate, frames, channels: source.channels });
  // 1. The level scan.
  const regions = planScanRegions(frames, rate, o.scanBudgetSec ?? SCAN_BUDGET_SEC, o.scanRegionSec ?? SCAN_REGION_SEC);
  const scanTotal = regions.reduce((a, g) => a + g.frames, 0);
  let scanned = 0;
  for (const region of regions) {
    target.startRegion();
    for (let at = 0; at < region.frames; at += chunk) {
      const n = Math.min(chunk, region.frames - at);
      const [l, r] = await read(region.start + at, n);
      await target.scan(l, r);
      scanned += n;
      progress((SCAN_SHARE * scanned) / Math.max(1, scanTotal));
    }
  }
  // 2. The song, front to back.
  for (let at = 0; at < frames; at += chunk) {
    const n = Math.min(chunk, frames - at);
    const [l, r] = await read(at, n);
    await target.chunk(l, r);
    progress(SCAN_SHARE + (PASS_END - SCAN_SHARE) * Math.min(1, (at + n) / frames));
  }
  o.signal?.throwIfAborted();
  // 3. Tempo, beats, bars, key, energy, sections.
  const analysis = await target.finish((f) => progress(PASS_END + (1 - PASS_END) * f));
  progress(1);
  return analysis;
}

/** The analysis on this thread (no Worker): each chunk is handled, then the page gets a turn. */
export function inlineStreamTarget(opts: { signal?: AbortSignal; yieldNow?: () => Promise<void> } = {}): StreamTarget {
  let run: StreamingAnalysis | null = null;
  const wait = opts.yieldNow ?? yieldToMain;
  const need = () => {
    if (!run) throw new Error('The analysis has not started.');
    return run;
  };
  return {
    start: (info) => void (run = new StreamingAnalysis(info)),
    startRegion: () => need().startScanRegion(),
    async scan(l, r) {
      need().scanChunk(l, r);
      await wait();
    },
    async chunk(l, r) {
      need().push(l, r);
      await wait();
    },
    async finish(onProgress) {
      await wait();
      return need().finish({ onProgress, ...(opts.signal ? { isCancelled: () => opts.signal!.aborted } : {}) });
    },
  };
}

/** Bytes of a file above which it is read by parts even when its length isn't known. */
const BIG_FILE_BYTES = 48 * 1024 * 1024;

/**
 * The song's file as a source read by parts, when it is long (or big, with no length known) and of a format that can
 * be (WAV, MP3); null otherwise: the caller decodes it whole.
 */
export async function openLongSource(ref: SampleRef, provider: Pick<SampleBytesProvider, 'getBlob'> = opfsSampleProvider()): Promise<StreamSource | null> {
  if (ref.source.kind !== 'embedded') return null;
  const known = ref.durationSec;
  if (known !== undefined && known <= LONG_SONG_SEC) return null;
  const blob = await provider.getBlob?.(ref);
  if (!blob) return null;
  if (known === undefined && blob.size <= BIG_FILE_BYTES) return null;
  // The rate given is the one a deck would convert to; the analysis reads the file's own.
  const source = await openSegmentSource({ reader: blobReader(blob), sampleRate: 44100, yieldNow: yieldToMain }).catch(() => null);
  if (!source) return null;
  if (source.nativeFrames / source.nativeRate <= LONG_SONG_SEC) {
    source.dispose();
    return null;
  }
  return source;
}
