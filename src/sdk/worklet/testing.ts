/**
 * Helpers for testing kernels in Node (Vitest): `import { … } from '@agstudio/sdk/worklet/testing'`.
 * Not part of the audio-thread bundle; kernels never import this.
 */
import { encode, type ParamSpecs, type ParamValue } from '../params';
import { Rng } from '../dsp/random';
import type { EffectKernel, InstrumentKernel, KernelHost, KernelTransport, ParamBlock } from './kernel';

/** Param values for one block: every param at its default or the given value (enum ids, booleans or numbers). */
export function paramBlock<P extends ParamSpecs>(
  specs: P,
  values: Partial<Record<keyof P, ParamValue>> = {},
): ParamBlock<P> {
  const out: Record<string, Float32Array> = {};
  for (const [id, spec] of Object.entries(specs))
    out[id] = new Float32Array([encode(spec, values[id] ?? spec.default)]);
  return out as ParamBlock<P>;
}

/** A kernel host with seeded randomness that records what the kernel posts. */
export function testHost(sampleRate = 48000, seed = 1, state?: unknown): KernelHost & { posted: unknown[] } {
  const rng = new Rng(seed);
  const posted: unknown[] = [];
  return { sampleRate, state, post: (msg) => posted.push(msg), rand: () => rng.next(), posted };
}

/** A transport that plays from `startBeat` at `bpm` (block frames are counted from 0). */
export class TestTransport implements KernelTransport {
  playing = true;
  /** Frame of the current block's first frame. */
  blockStart = 0;
  constructor(
    public bpm: number,
    private readonly sampleRate: number,
    private readonly startBeat = 0,
  ) {}
  beatAt(i: number): number {
    return this.startBeat + ((this.blockStart + i) * this.bpm) / 60 / this.sampleRate;
  }
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
  const transport = kernel.transport instanceof TestTransport ? kernel.transport : null;
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
