/**
 * Latency measurement rig (browser tests only).
 *
 * A probe worklet sits behind the engine's master (after the safety limiter) and records the context frame of the
 * first sample louder than a threshold once armed (test/browser/latency-probe.worklet.ts). A frame is turned into
 * the moment it reaches the speakers with the output timestamp pair (`getOutputTimestamp`: the context time being
 * heard now and the `performance.now()` it belongs to), so a measurement runs from the `performance.now()` of the
 * event (a key's `event.timeStamp`, a MIDI message, the call of `play()`) to the speaker, output latency included.
 *
 * Each measurement is split into parts:
 *  - `handling`: event → the engine call (main thread: key handler, live input, history);
 *  - `transit`: the engine call → the first sample at the master, in context time (message to the audio thread, the
 *    wait for its next render quantum, the render itself); it starts at `currentTime`, which is what the engine
 *    stamps its events with, and so also includes how far `currentTime` is behind the audio thread;
 *  - `rest`: what remains of the total: the output buffer and the device (about `outputLatency + baseLatency`).
 */
import probeUrl from '../browser/latency-probe.worklet.ts?worker&url';
import type { Engine } from '@engine/engine';
import type { EngineApi } from '@engine/api';

const STATE = 0;
const HIT = 1;
const THRESHOLD = 4;

/** The realtime `Engine` behind a host (or the engine itself). */
export function innerEngine(engine: EngineApi): Engine {
  const inner = (engine as unknown as { inner?: Engine }).inner;
  return inner ?? (engine as unknown as Engine);
}

export class Probe {
  private readonly s: Float64Array;

  private constructor(
    readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    sab: SharedArrayBuffer,
  ) {
    this.s = new Float64Array(sab);
  }

  /** Connects a probe behind the engine's output (the limiter when there is one, else the master). */
  static async attach(engine: Engine, threshold = 0.02): Promise<Probe> {
    const ctx = engine.ctx as AudioContext;
    await engine.loadModule(probeUrl);
    const sab = new SharedArrayBuffer(8 * 8);
    const node = new AudioWorkletNode(ctx, 'latency-probe', {
      processorOptions: { sab },
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const priv = engine as unknown as { limiter: AudioNode | null; masterOut: AudioNode };
    (priv.limiter ?? priv.masterOut).connect(node);
    node.connect(ctx.destination);
    const probe = new Probe(ctx, node, sab);
    probe.s[THRESHOLD] = threshold;
    return probe;
  }

  /** Listens for the next sound above the threshold. */
  arm(): void {
    this.s[STATE] = 1;
  }

  /** Stops listening. */
  disarm(): void {
    this.s[STATE] = 0;
  }

  /** The context frame of the first loud sample since `arm()`, or null after `ms` of silence. */
  async hit(ms = 1500): Promise<number | null> {
    const end = performance.now() + ms;
    while (this.s[STATE] !== 2) {
      if (performance.now() > end) {
        this.disarm();
        return null;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    return this.s[HIT] as number;
  }

  /** `performance.now()` at which context frame `frame` reaches the speakers. */
  heardAt(frame: number): number {
    const ts = this.ctx.getOutputTimestamp();
    return (ts.performanceTime as number) + (frame / this.ctx.sampleRate - (ts.contextTime as number)) * 1000;
  }

  /** Context time (seconds) at the start of the last block the probe rendered. */
  lastBlockTime(): number {
    return (this.s[2] as number) / this.ctx.sampleRate;
  }

  /** Quiet for `ms`: nothing above the threshold is arriving (a note's release is over). */
  async quiet(ms = 120): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  dispose(): void {
    this.node.disconnect();
  }
}

/** One measurement, all in ms. */
export interface Sample {
  total: number;
  handling: number;
  transit: number;
  rest: number;
}

export interface Summary {
  n: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

export function summarize(xs: readonly number[]): Summary {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] as number;
  return { n: s.length, median: at(0.5), p95: at(0.95), min: s[0] as number, max: s[s.length - 1] as number };
}

export const fmt = (x: number) => x.toFixed(1).padStart(6);

/** `LAT | label | n | median | p95 | min | max` (a stable line to grep from the test output). */
export function row(label: string, xs: readonly number[]): string {
  const m = summarize(xs);
  return `LAT | ${label.padEnd(44)} | n=${String(m.n).padStart(3)} | median ${fmt(m.median)} | p95 ${fmt(m.p95)} | min ${fmt(m.min)} | max ${fmt(m.max)}`;
}

/**
 * Times one trigger. `call` is filled in by whatever the trigger runs (`markCall()` at the engine call); `t0` is the
 * event time. Resolves with the parts, or null when no sound arrived.
 */
export interface Trigger {
  /** Starts the event; returns its `performance.now()` time (a key's timeStamp, a message's time). */
  fire(mark: () => void): number;
}

export async function measure(probe: Probe, ctx: AudioContext, trigger: Trigger, timeoutMs = 1500): Promise<Sample | null> {
  let tCall = NaN;
  let ctxCall = NaN;
  probe.arm();
  // The probe sees the arm on its next block; give it a moment so a leftover note can't count.
  await new Promise((r) => setTimeout(r, 10));
  probe.arm();
  const t0 = trigger.fire(() => {
    tCall = performance.now();
    ctxCall = ctx.currentTime;
  });
  const frame = await probe.hit(timeoutMs);
  if (frame === null || Number.isNaN(tCall)) return null;
  const heard = probe.heardAt(frame);
  const total = heard - t0;
  const handling = tCall - t0;
  const transit = (frame / ctx.sampleRate - ctxCall) * 1000;
  return { total, handling, transit, rest: total - handling - transit };
}
