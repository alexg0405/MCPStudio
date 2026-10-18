/** Runs kernels block by block in Node, the way the SDK's processor does, and returns what they output. */
import type { ParamSpecs } from '../params';
import type { EffectKernel, InstrumentKernel, KernelHost, ParamBlock } from '../worklet/kernel';
import { DEFAULT_BLOCK_FRAMES, DEFAULT_SAMPLE_RATE } from './defaults';
import { testHost, testTransport, type TestHostOptions, type TestSignal, type TestTransport } from './host';
import { paramBlock, type TestParams } from './params';

/** Options for `runEffect` and `runInstrument`: params (constant or automated), block size, transport, sidechain and notes. */
export interface RunOptions<P extends ParamSpecs> extends TestHostOptions {
  params?: TestParams<P>;
  /** Frames per process() call (default 128). */
  block?: number;
  /** The song transport at frame 0 of the run (default: stopped at 120 BPM). */
  transport?: { bpm?: number; playing?: boolean; beat?: number } | TestTransport;
  /** Effects with a sidechain: the key signal (default: none, the kernel gets `undefined`). */
  sidechain?: TestSignal;
  /**
   * Effects that follow notes (`notes: { param }`): events for the kernel's `noteOn` / `noteOff`, applied at the start
   * of the block their frame falls in, as the SDK's runner does.
   */
  notes?: readonly { frame: number; key: number; velocity?: number; off?: boolean; id?: number }[];
}

type EffectLike<P extends ParamSpecs> = EffectKernel<P> | (new (host: KernelHost) => EffectKernel<P>);

/** The transport a run gives its kernel: the one passed in, or a new one built from the options (stopped by default). */
function transportFor(option: RunOptions<ParamSpecs>['transport'], sampleRate: number): TestTransport {
  if (option && 'beatAt' in option) return option;
  return testTransport({ playing: false, ...option, sampleRate });
}

/** The params of a run: constants, plus one reusable per-frame array for each param driven by a function. */
interface Automation {
  readonly params: Record<string, Float32Array>;
  readonly driven: { key: string; curve: (frame: number) => number; frames: Float32Array }[];
}

function startAutomation<P extends ParamSpecs>(specs: P, values: TestParams<P> | undefined, block: number): Automation {
  const params = { ...paramBlock(specs, values) } as Record<string, Float32Array>;
  const driven = Object.entries(values ?? {})
    .filter(([, v]) => typeof v === 'function')
    .map(([key, curve]) => ({ key, curve: curve as (frame: number) => number, frames: new Float32Array(block) }));
  return { params, driven };
}

/** Fills the driven params for the `n` frames of the block starting at frame `at`. */
function automateBlock(automation: Automation, at: number, n: number, block: number): void {
  for (const { key, curve, frames } of automation.driven) {
    for (let i = 0; i < n; i++) frames[i] = curve(at + i);
    automation.params[key] = n === block ? frames : frames.subarray(0, n);
  }
}

/** Hands the effect the notes whose frame falls in the block [at, at + n). */
function sendNotes<P extends ParamSpecs>(k: EffectKernel<P>, notes: RunOptions<P>['notes'], at: number, n: number): void {
  for (const ev of notes ?? []) {
    if (ev.frame < at || ev.frame >= at + n) continue;
    if (ev.off) k.noteOff?.(ev.id ?? ev.key, ev.key, ev.velocity ?? 0.5);
    else k.noteOn?.(ev.key, ev.velocity ?? 0.8, ev.id ?? ev.key);
  }
}

/** A buffer's first `n` frames (the buffer itself when it is exactly that long). */
function firstFrames(buffer: Float32Array, n: number): Float32Array {
  return n === buffer.length ? buffer : buffer.subarray(0, n);
}

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
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const k = typeof kernel === 'function' ? new kernel(testHost({ ...opts, sampleRate })) : kernel;
  const transport = transportFor(opts.transport, sampleRate);
  k.transport = transport;
  const block = opts.block ?? DEFAULT_BLOCK_FRAMES;
  const out: [Float32Array, Float32Array] = [new Float32Array(frames), new Float32Array(frames)];
  const inL = new Float32Array(block);
  const inR = new Float32Array(block);
  const scL = new Float32Array(block);
  const scR = new Float32Array(block);
  const outL = new Float32Array(block);
  const outR = new Float32Array(block);
  const automation = startAutomation(specs, opts.params, block);
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
    automateBlock(automation, at, n, block);
    transport.blockStart = at;
    sendNotes(k, opts.notes, at, n);
    const blockOut = [firstFrames(outL, n), firstFrames(outR, n)];
    const sidechain = opts.sidechain ? [firstFrames(scL, n), firstFrames(scR, n)] : undefined;
    k.process([firstFrames(inL, n), firstFrames(inR, n)], blockOut, n, automation.params as ParamBlock<P>, sidechain);
    out[0].set(blockOut[0] as Float32Array, at);
    out[1].set(blockOut[1] as Float32Array, at);
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
  const block = opts.block ?? DEFAULT_BLOCK_FRAMES;
  const transport = transportFor(opts.transport, opts.sampleRate ?? DEFAULT_SAMPLE_RATE);
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

/** A call to make at an exact frame of `renderInstrument` (a note on, a controller move). */
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
  block = DEFAULT_BLOCK_FRAMES,
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
  block = DEFAULT_BLOCK_FRAMES,
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
