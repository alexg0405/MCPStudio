/**
 * `@agstudio/sdk/testing`: run worklet kernels in plain Vitest (Node), without an AudioContext.
 *
 * ```ts
 * import { runEffect } from '@agstudio/sdk/testing';
 * const [left] = runEffect(MyKernel, params, (i) => Math.sin(i * 0.05), 48000, { params: { drive: 12 } });
 * ```
 *
 * Blocks are 128 frames like in Chrome; params are given in their own units (enums by option id,
 * bools as booleans) and may be functions of the frame for automation. Kernels see a stopped
 * transport at 120 BPM unless you pass `transport`.
 */
import { encode, type ParamSpecs, type ParamValue } from './params';
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

/** A KernelHost for tests (seeded random numbers, posts go to `onPost`). */
export function testHost(opts: TestHostOptions = {}): KernelHost {
  let s = (opts.seed ?? 1) >>> 0;
  return {
    sampleRate: opts.sampleRate ?? 48000,
    state: opts.state,
    post: (msg) => opts.onPost?.(msg),
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
    k.process([view(inL), view(inR)], o, n, params as ParamBlock<P>, opts.sidechain ? [view(scL), view(scR)] : undefined);
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
