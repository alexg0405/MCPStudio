/**
 * `@agstudio/sdk/testing`: run worklet kernels in plain Vitest (Node), without an AudioContext.
 *
 * ```ts
 * import { runEffect } from '@agstudio/sdk/testing';
 * const [left] = runEffect(MyKernel, params, (i) => Math.sin(i * 0.05), 48000, { params: { drive: 12 } });
 * ```
 *
 * For instruments, `renderInstrument` plays notes at exact frames (the way the SDK's processor splits
 * blocks); `rms` and `peak` measure the result.
 *
 * Blocks are 128 frames like in Chrome; params are given in their own units (enums by option id,
 * bools as booleans) and may be functions of the frame for automation. Kernels see a stopped
 * transport at 120 BPM unless you pass `transport`.
 */
import { encode, fromNormalized, type FloatSpec, type ParamSpecs, type ParamValue } from './params';
import type { EffectKernel, InstrumentKernel, KernelHost, KernelTransport, ParamBlock } from './worklet/kernel';

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
  const sampleRate = opts.sampleRate ?? 48000;
  const beat0 = opts.beat ?? 0;
  const t: TestTransport = {
    playing: opts.playing ?? true,
    bpm: opts.bpm ?? 120,
    blockStart: 0,
    beatAt(i: number) {
      return t.playing ? beat0 + ((t.blockStart + i) * t.bpm) / 60 / sampleRate : beat0;
    },
  };
  return t;
}

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
    sampleRate: opts.sampleRate ?? 48000,
    state: opts.state,
    posted,
    post: (msg) => {
      posted.push(msg);
      onPost?.(msg);
    },
    rand: () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Param values for a test: plain values, or functions of the frame (automation). */
export type TestParams<P extends ParamSpecs> = { [K in keyof P]?: ParamValue | ((frame: number) => number) };

/** A constant param block (enums as option index, bools as 0/1), the way the SDK's processor passes it. */
export function paramBlock<P extends ParamSpecs>(specs: P, values: TestParams<P> = {}): ParamBlock<P> {
  const out: Record<string, Float32Array> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const v = values[key as keyof P];
    out[key] = new Float32Array([typeof v === 'function' ? v(0) : encode(spec, v ?? spec.default)]);
  }
  return out as ParamBlock<P>;
}

export interface RunOptions<P extends ParamSpecs> extends TestHostOptions {
  params?: TestParams<P>;
  /** Frames per process() call (default 128). */
  block?: number;
  /** The song transport at frame 0 of the run (default: stopped at 120 BPM). */
  transport?: { bpm?: number; playing?: boolean; beat?: number } | TestTransport;
  /** Effects with a sidechain: the key signal (default: none, the kernel gets `undefined`). */
  sidechain?: TestSignal;
}

type EffectLike<P extends ParamSpecs> = EffectKernel<P> | (new (host: KernelHost) => EffectKernel<P>);

/**
 * Runs an effect kernel (a class, or an instance to keep its state between runs) over `frames`
 * frames of a stereo input; returns the left and right output.
 */
export function runEffect<P extends ParamSpecs>(
  kernel: EffectLike<P>,
  specs: P,
  input: TestSignal,
  frames: number,
  opts: RunOptions<P> = {},
): [Float32Array, Float32Array] {
  const sampleRate = opts.sampleRate ?? 48000;
  const k = typeof kernel === 'function' ? new kernel(testHost({ ...opts, sampleRate })) : kernel;
  const transport =
    opts.transport && 'beatAt' in opts.transport
      ? opts.transport
      : testTransport({ playing: false, ...opts.transport, sampleRate });
  k.transport = transport;
  const block = opts.block ?? 128;
  const out: [Float32Array, Float32Array] = [new Float32Array(frames), new Float32Array(frames)];
  const inL = new Float32Array(block);
  const inR = new Float32Array(block);
  const scL = new Float32Array(block);
  const scR = new Float32Array(block);
  const outL = new Float32Array(block);
  const outR = new Float32Array(block);
  const base = paramBlock(specs, opts.params);
  const automated = Object.entries(opts.params ?? {}).filter(([, v]) => typeof v === 'function') as [
    string,
    (frame: number) => number,
  ][];
  const curves = new Map(automated.map(([key]) => [key, new Float32Array(block)]));
  const params = { ...base } as Record<string, Float32Array>;
  for (let at = 0; at < frames; at += block) {
    const n = Math.min(block, frames - at);
    for (let i = 0; i < n; i++) {
      inL[i] = input(at + i, 0);
      inR[i] = input(at + i, 1);
      if (opts.sidechain) {
        scL[i] = opts.sidechain(at + i, 0);
        scR[i] = opts.sidechain(at + i, 1);
      }
    }
    for (const [key, curve] of automated) {
      const arr = curves.get(key) as Float32Array;
      for (let i = 0; i < n; i++) arr[i] = curve(at + i);
      params[key] = n === block ? arr : arr.subarray(0, n);
    }
    transport.blockStart = at;
    const view = (a: Float32Array) => (n === block ? a : a.subarray(0, n));
    const o = [view(outL), view(outR)];
    k.process(
      [view(inL), view(inR)],
      o,
      n,
      params as ParamBlock<P>,
      opts.sidechain ? [view(scL), view(scR)] : undefined,
    );
    out[0].set(o[0] as Float32Array, at);
    out[1].set(o[1] as Float32Array, at);
  }
  return out;
}

/** Runs an instrument kernel for `frames` frames; `events(frame)` is called at each block start. */
export function runInstrument<P extends ParamSpecs>(
  kernel: InstrumentKernel<P>,
  specs: P,
  frames: number,
  opts: RunOptions<P> & { events?(frame: number, k: InstrumentKernel<P>): void } = {},
): [Float32Array, Float32Array] {
  const block = opts.block ?? 128;
  const transport =
    opts.transport && 'beatAt' in opts.transport
      ? opts.transport
      : testTransport({ playing: false, ...opts.transport, sampleRate: opts.sampleRate ?? 48000 });
  kernel.transport = transport;
  const params = paramBlock(specs, opts.params);
  const out: [Float32Array, Float32Array] = [new Float32Array(frames), new Float32Array(frames)];
  const L = new Float32Array(block);
  const R = new Float32Array(block);
  for (let at = 0; at < frames; at += block) {
    const n = Math.min(block, frames - at);
    opts.events?.(at, kernel);
    L.fill(0);
    R.fill(0);
    transport.blockStart = at;
    kernel.render([L, R], 0, n, params);
    out[0].set(L.subarray(0, n), at);
    out[1].set(R.subarray(0, n), at);
  }
  return out;
}

export interface KernelEvent {
  /** Frame (from the start of the render) at which `run` is called, before that frame renders. */
  frame: number;
  run(): void;
}

/**
 * Renders `frames` frames of an instrument kernel in blocks, calling each event at its exact frame
 * (the way the SDK's processor splits blocks). `params` may be a function of the block's first frame
 * (for automation). Returns [left, right].
 */
export function renderInstrument<P extends ParamSpecs>(
  kernel: InstrumentKernel<P>,
  frames: number,
  params: ParamBlock<P> | ((frame: number) => ParamBlock<P>),
  events: readonly KernelEvent[] = [],
  block = 128,
): [Float32Array, Float32Array] {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const queue = [...events].sort((a, b) => a.frame - b.frame);
  // A test transport (`testTransport()`) follows the blocks.
  const transport = 'blockStart' in kernel.transport ? (kernel.transport as TestTransport) : null;
  let next = 0;
  for (let b0 = 0; b0 < frames; b0 += block) {
    const n = Math.min(block, frames - b0);
    const l = L.subarray(b0, b0 + n);
    const r = R.subarray(b0, b0 + n);
    const p = typeof params === 'function' ? params(b0) : params;
    if (transport) transport.blockStart = b0;
    let pos = 0;
    while (pos < n) {
      const at = next < queue.length ? Math.max(pos, Math.min(n, (queue[next] as KernelEvent).frame - b0)) : n;
      if (at > pos) kernel.render([l, r], pos, at, p);
      if (at >= n) break;
      while (next < queue.length && (queue[next] as KernelEvent).frame - b0 <= at) (queue[next++] as KernelEvent).run();
      pos = at;
    }
  }
  return [L, R];
}

/** Runs an effect kernel over a stereo input in blocks. Returns [left, right]. */
export function processEffect<P extends ParamSpecs>(
  kernel: EffectKernel<P>,
  input: [Float32Array, Float32Array],
  params: ParamBlock<P>,
  block = 128,
): [Float32Array, Float32Array] {
  const frames = input[0].length;
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let b0 = 0; b0 < frames; b0 += block) {
    const n = Math.min(block, frames - b0);
    kernel.process(
      [input[0].subarray(b0, b0 + n), input[1].subarray(b0, b0 + n)],
      [L.subarray(b0, b0 + n), R.subarray(b0, b0 + n)],
      n,
      params,
    );
  }
  return [L, R];
}

/** Root mean square of `x` over frames [from, to). */
export function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(x.length, Math.floor(to));
  for (let i = a; i < b; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, b - a));
}

/** Largest absolute value of `x` over frames [from, to). */
export function peak(x: Float32Array, from = 0, to = x.length): number {
  let m = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) m = Math.max(m, Math.abs(x[i] as number));
  return m;
}

// Golden references. A kernel rendered with automated params is compared with values recorded from the same run
// before the kernel was optimized: chunk RMS (dB) and every 256th sample, and steady output by bit hash.

/** Length of a golden run: 2 s at 48 kHz. */
export const GOLDEN_FRAMES = 96000;

/** Music-like test input: a sine pair, plus a noise burst every 200 ms that decays over 12 ms. Deterministic. */
export function goldenInput(frame: number, channel: number): number {
  const t = frame / 48000;
  const burst = Math.exp(-((frame % 9600) / 48000) / 0.012) * 0.6 * noise(frame, channel);
  return 0.25 * Math.sin(2 * Math.PI * 110 * t + channel * 0.3) + 0.15 * Math.sin(2 * Math.PI * 330 * t) + burst;
}

/** Deterministic white noise in [-1, 1) for a frame and channel. */
function noise(frame: number, channel: number): number {
  let x = Math.imul((frame * 2 + channel) ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967296) * 2 - 1;
}

/**
 * Per-frame automation for the given float params, as the CPU benchmark draws it (`--automate`): a
 * sine across each param's normalized range (so log and dB ranges are swept evenly to the ear) at
 * 0.25 Hz, the phases spread over three sweeps.
 */
export function goldenSweeps<P extends ParamSpecs>(specs: P, keys: readonly (keyof P & string)[]): TestParams<P> {
  const out: Record<string, (frame: number) => number> = {};
  keys.forEach((key, k) => {
    const spec = specs[key] as FloatSpec;
    const phase = k / 3;
    out[key] = (frame) =>
      Number(fromNormalized(spec, 0.5 + 0.5 * Math.sin(2 * Math.PI * (0.25 * (frame / 48000) + phase))));
  });
  return out as TestParams<P>;
}

/** RMS of each full chunk of `size` frames of x. */
export function chunkRms(x: Float32Array, size = 1024): number[] {
  const out: number[] = [];
  for (let c = 0; c + size <= x.length; c += size) out.push(rms(x, c, c + size));
  return out;
}

/** Every `stride`-th sample of x. */
export function strided(x: Float32Array, stride = 256): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i += stride) out.push(x[i] as number);
  return out;
}

/** FNV-1a over the IEEE-754 bits of every sample: equal hashes mean bit-identical output. */
export function bitHash(x: Float32Array): string {
  const bits = new Uint32Array(x.buffer, x.byteOffset, x.length);
  let h = 0x811c9dc5;
  for (const word of bits) h = Math.imul(h ^ word, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Largest |a - b| over the samples of a and b (of equal length). */
export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
  return m;
}

/** Level difference in dB between two RMS values; a floor at -120 dBFS keeps silence finite. */
export function rmsDb(a: number, b: number): number {
  return 20 * Math.log10((a + 1e-6) / (b + 1e-6));
}

// Speed tests. A busy machine (parallel workers, other programs) makes the wall clock mostly measure how long the
// process waited for a core, so a kernel-cost or render-speed assertion should use CPU time and the best of a few
// attempts: interference only ever adds time, and a quiet machine pays for a single attempt.

/** CPU time spent by this process so far, in ms (wall-clock `performance.now()` where the runtime has no CPU clock). */
export function cpuNow(): number {
  const proc = (globalThis as { process?: { cpuUsage?: () => { user: number; system: number } } }).process;
  if (typeof proc?.cpuUsage === 'function') {
    const u = proc.cpuUsage();
    return (u.user + u.system) / 1000;
  }
  return performance.now();
}

/** How a measurement compares: a duration is better lower, a speed or a throughput factor is better higher. */
export type Better = 'lower' | 'higher';

/**
 * Measure up to `attempts` times and return the best value, stopping at the first attempt whose best-so-far
 * satisfies `pass`. The caller asserts on the result as usual, so a real regression (every attempt slow)
 * still fails.
 */
export async function settle(
  measure: () => number | Promise<number>,
  pass: (best: number) => boolean,
  { attempts = 4, better = 'lower' }: { attempts?: number; better?: Better } = {},
): Promise<number> {
  let best = better === 'lower' ? Infinity : -Infinity;
  for (let i = 0; i < attempts; i++) {
    const v = await measure();
    best = better === 'lower' ? Math.min(best, v) : Math.max(best, v);
    if (pass(best)) break;
  }
  return best;
}
