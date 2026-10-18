/** A kernel's surroundings for tests: a host with seeded randomness and a song transport that follows the rendered frames. */
import type { KernelHost, KernelTransport } from '../worklet/kernel';
import { DEFAULT_SAMPLE_RATE } from './defaults';

const SECONDS_PER_MINUTE = 60;

/** A test signal: the sample at a frame for a channel (0 = left, 1 = right). */
export type TestSignal = (frame: number, channel: number) => number;

/** A transport whose song position advances with the frames a test renders. */
export interface TestTransport extends KernelTransport {
  playing: boolean;
  bpm: number;
  /** Context frame of the current block's first frame (the runner moves it). */
  blockStart: number;
}

/** A song transport for kernel tests: playing (or stopped) at `beat` when frame 0 renders. */
export function testTransport(
  opts: { bpm?: number; playing?: boolean; beat?: number; sampleRate?: number } = {},
): TestTransport {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const beat0 = opts.beat ?? 0;
  const t: TestTransport = {
    playing: opts.playing ?? true,
    bpm: opts.bpm ?? 120,
    blockStart: 0,
    beatAt(i: number) {
      return t.playing ? beat0 + ((t.blockStart + i) * t.bpm) / SECONDS_PER_MINUTE / sampleRate : beat0;
    },
  };
  return t;
}

/** Options for `testHost`. */
export interface TestHostOptions {
  sampleRate?: number;
  state?: unknown;
  /** Receives everything the kernel posts (`host.post`). */
  onPost?(msg: unknown): void;
  /** Seed of `host.rand()`. */
  seed?: number;
}

/**
 * A KernelHost for tests: seeded random numbers, and what the kernel posts kept in `posted` (and
 * passed to `onPost`). `testHost(48000)` is short for `testHost({ sampleRate: 48000 })`.
 */
export function testHost(
  opts: TestHostOptions | number = {},
  seed?: number,
  state?: unknown,
): KernelHost & { posted: unknown[] } {
  if (typeof opts === 'number') opts = { sampleRate: opts, seed, state };
  const { onPost } = opts;
  let s = (opts.seed ?? 1) >>> 0;
  const posted: unknown[] = [];
  return {
    sampleRate: opts.sampleRate ?? DEFAULT_SAMPLE_RATE,
    state: opts.state,
    posted,
    post: (msg) => {
      posted.push(msg);
      onPost?.(msg);
    },
    // mulberry32, the generator `Rng` uses.
    rand: () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
