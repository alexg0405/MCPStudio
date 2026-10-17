import { LinkwitzRiley } from '@agstudio/sdk';
import { shareDb, TONE_BANDS, TONE_CROSSOVERS, type ToneBand } from '@core/reference/bands';
import type { ToneMeasure } from '@core/reference/track';

/**
 * The coarse spectral balance of a recording: the energy of its mid signal in each of the eight
 * `TONE_BANDS` (cascaded Linkwitz–Riley splits, like `analysis/measure.ts` with more bands) and its
 * stereo width, over the whole song and over each of the sections of an analysis. The reference and the
 * musician's mix are measured by this one piece of code, so their bands compare.
 */
const N = TONE_BANDS.length;

/** Energy per band plus the mid and side energy of the audio seen so far. */
export class ToneSum {
  readonly bands = new Float64Array(N);
  mid = 0;
  side = 0;

  add(other: ToneSum): void {
    for (let i = 0; i < N; i++) this.bands[i] = this.bands[i]! + other.bands[i]!;
    this.mid += other.mid;
    this.side += other.side;
  }

  /** Shares in dB under the total, and side over mid. */
  result(): { bands: number[]; width: number } {
    return { bands: shareDb(this.bands), width: this.mid > 0 ? this.side / this.mid : this.side > 0 ? Infinity : 0 };
  }

  get silent(): boolean {
    return this.mid + this.side < 1e-12;
  }
}

export class SpectrumMeter {
  private readonly splits: LinkwitzRiley[];

  constructor(sampleRate: number) {
    this.splits = TONE_CROSSOVERS.map((f) => new LinkwitzRiley().set(f, sampleRate));
  }

  /** Adds the samples [from, to) to `into`. Mono audio: pass the same array twice. */
  push(left: Float32Array, right: Float32Array, from: number, to: number, into: ToneSum): void {
    const splits = this.splits;
    const bands = into.bands;
    let mid = 0;
    let side = 0;
    for (let i = from; i < to; i++) {
      const l = left[i] as number;
      const r = right[i] as number;
      const m = (l + r) * 0.5;
      const sd = (l - r) * 0.5;
      mid += m * m;
      side += sd * sd;
      let rest = m;
      for (let b = 0; b < splits.length; b++) {
        const x = splits[b] as LinkwitzRiley;
        x.split(rest);
        bands[b] = (bands[b] as number) + x.low * x.low;
        rest = x.high;
      }
      bands[splits.length] = (bands[splits.length] as number) + rest * rest;
    }
    into.mid += mid;
    into.side += side;
  }
}

/** Lets the UI breathe between pieces (not setTimeout: a hidden tab throttles it to a second per call). */
export const yieldToUi = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(0);
  });
};

export interface ToneOptions {
  signal?: AbortSignal;
  onProgress?(fraction: number): void;
}

/** Side over mid, kept finite (a signal that is all side counts as 10). */
const capWidth = (w: number) => (Number.isNaN(w) ? 0 : Math.min(10, w));

/** Audio between yields: about 3 s at 44.1 kHz. */
const CHUNK = 131072;

/**
 * Measures the whole recording and each span of `spans` (seconds, in order; they may leave gaps).
 * Rejects with the signal's reason when aborted.
 */
export async function measureTone(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  spans: readonly { start: number; end: number }[] = [],
  opts: ToneOptions = {},
): Promise<ToneMeasure> {
  const meter = new SpectrumMeter(sampleRate);
  const total = new ToneSum();
  const parts = spans.map(() => new ToneSum());
  const frames = Math.min(left.length, right.length);
  const edges = spans.map((s) => ({ from: Math.max(0, Math.round(s.start * sampleRate)), to: Math.min(frames, Math.round(s.end * sampleRate)) }));
  // Cut points: every span edge, then every CHUNK samples between them.
  const cuts = new Set<number>([0, frames]);
  for (const e of edges) {
    cuts.add(Math.min(frames, e.from));
    cuts.add(Math.min(frames, e.to));
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  let done = 0;
  for (let k = 0; k + 1 < sorted.length; k++) {
    for (let at = sorted[k]!; at < sorted[k + 1]!; ) {
      const end = Math.min(sorted[k + 1]!, at + CHUNK);
      const piece = new ToneSum();
      meter.push(left, right, at, end, piece);
      total.add(piece);
      // Spans may overlap by a sample at most; a piece belongs to the span that holds it.
      for (let i = 0; i < edges.length; i++) if (at >= edges[i]!.from && end <= edges[i]!.to) parts[i]!.add(piece);
      done += end - at;
      at = end;
      opts.signal?.throwIfAborted();
      opts.onProgress?.(frames > 0 ? done / frames : 1);
      await yieldToUi();
    }
  }
  const whole = total.result();
  return {
    bands: whole.bands,
    width: capWidth(whole.width),
    sections: parts.map((p) => {
      const r = p.result();
      return { bands: r.bands, width: capWidth(r.width) };
    }),
  };
}

export type { ToneBand };
