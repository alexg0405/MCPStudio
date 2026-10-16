/**
 * Runs a built-in kernel (see builtin-kernels.ts) through a timeline of parameter sets, for the
 * plugin sweep and the benchmark. Effects get a stereo music-like signal (or silence); instruments
 * play a chord that is released partway.
 */
import type { ParamSpecs, ParamValue } from '@agstudio/sdk';
import { paramBlock, testTransport } from '@agstudio/sdk/testing';
import type { ParamBlock } from '@agstudio/sdk/worklet';
import type { KernelEntry } from './builtin-kernels';

export const SR = 48000;
export const BLOCK = 128;

/** Deterministic noise in [-1, 1). */
export function noiseGen(seed = 12345): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/** A stereo signal: a decaying chord restarting every half second plus a noise hit on the beat. */
export function musicInput(frames: number, sampleRate = SR, amp = 1): [Float32Array, Float32Array] {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const rnd = noiseGen(777);
  const freqs = [110, 165, 220, 277.2, 330, 440];
  for (let i = 0; i < frames; i++) {
    const t = (i % (sampleRate / 2)) / sampleRate;
    const env = Math.exp(-t * 6);
    let x = 0;
    for (const f of freqs) x += Math.sin(2 * Math.PI * f * (i / sampleRate)) * 0.08;
    const hit = t < 0.05 ? 0.5 * (1 - t / 0.05) : 0;
    L[i] = amp * (x * env + rnd() * hit);
    R[i] = amp * (x * env * 0.9 + rnd() * hit);
  }
  return [L, R];
}

/** A kick-like key signal for sidechains. */
export function keyInput(frames: number, sampleRate = SR): [Float32Array, Float32Array] {
  const L = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = (i % (sampleRate / 2)) / sampleRate;
    L[i] = Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 18) * 0.9;
  }
  return [L, L];
}

export interface Segment {
  /** Seconds this parameter set applies for. */
  seconds: number;
  values: Record<string, ParamValue>;
}

export interface RunResult {
  L: Float32Array;
  R: Float32Array;
  /** Seconds the run lasted. */
  frames: number;
}

export interface RunOptions {
  /** Effects: what to feed (default `music` for the whole run). A function gives the input amplitude by second. */
  input?: 'music' | 'silence' | ((second: number) => number);
  /** Instruments: seconds after which the chord is released (default: never). */
  releaseAt?: number;
  /** Instruments: velocity of the notes (default 0.8). */
  velocity?: number;
  /** Instruments: the keys to play (default the entry's chord). */
  keys?: readonly number[];
  playing?: boolean;
  bpm?: number;
}

export function runEntry(entry: KernelEntry, timeline: readonly Segment[], opts: RunOptions = {}): RunResult {
  const frames = timeline.reduce((n, s) => n + Math.round(s.seconds * SR), 0);
  const total = Math.ceil(frames / BLOCK) * BLOCK;
  const inst = entry.kind === 'instrument' ? entry.make(SR) : null;
  const fx = entry.kind === 'effect' ? entry.make(SR) : null;
  const transport = testTransport({ playing: opts.playing ?? true, bpm: opts.bpm ?? 120, sampleRate: SR });
  if (inst) inst.transport = transport;
  if (fx) fx.transport = transport;
  const outL = new Float32Array(total);
  const outR = new Float32Array(total);
  const bl = new Float32Array(BLOCK);
  const br = new Float32Array(BLOCK);
  const music = entry.kind === 'effect' && opts.input !== 'silence' ? musicInput(total) : null;
  const key = entry.kind === 'effect' && entry.sidechain ? keyInput(total) : null;
  const gain = typeof opts.input === 'function' ? opts.input : null;
  const blocks = timeline.map((s) => ({
    end: 0,
    block: paramBlock(entry.params as ParamSpecs, s.values) as ParamBlock,
  }));
  let acc = 0;
  timeline.forEach((s, i) => {
    acc += Math.round(s.seconds * SR);
    (blocks[i] as { end: number }).end = acc;
  });
  let segment = 0;
  let id = 1;
  const keys = opts.keys ?? (entry.kind === 'instrument' ? entry.keys : []);
  const ids: number[] = [];
  let released = false;
  for (let at = 0; at < total; at += BLOCK) {
    while (segment < blocks.length - 1 && at >= (blocks[segment] as { end: number }).end) segment++;
    const params = (blocks[segment] as { block: ParamBlock }).block;
    transport.blockStart = at;
    bl.fill(0);
    br.fill(0);
    if (inst) {
      if (at === 0)
        for (const k of keys) {
          ids.push(id);
          inst.noteOn(k, opts.velocity ?? 0.8, id++, 0, 0);
        }
      if (!released && opts.releaseAt !== undefined && at >= opts.releaseAt * SR) {
        released = true;
        keys.forEach((k, n) => inst.noteOff(ids[n] as number, k, 0.5));
      }
      inst.render([bl, br], 0, BLOCK, params);
    } else if (fx) {
      const amp = gain ? gain(at / SR) : 1;
      const inL = new Float32Array(BLOCK);
      const inR = new Float32Array(BLOCK);
      if (music) {
        for (let i = 0; i < BLOCK; i++) {
          inL[i] = (music[0][at + i] as number) * amp;
          inR[i] = (music[1][at + i] as number) * amp;
        }
      }
      const sc = key ? [key[0].subarray(at, at + BLOCK), key[1].subarray(at, at + BLOCK)] : undefined;
      fx.process([inL, inR], [bl, br], BLOCK, params, sc);
    }
    outL.set(bl, at);
    outR.set(br, at);
  }
  return { L: outL.subarray(0, frames), R: outR.subarray(0, frames), frames };
}

/** Largest absolute value over [from, to) seconds, and whether anything is NaN/Infinity. */
export function stats(r: RunResult, fromSec = 0, toSec = Infinity) {
  const a = Math.floor(fromSec * SR);
  const b = Math.min(r.frames, Math.floor(toSec * SR));
  let peak = 0;
  let bad = 0;
  let dc = 0;
  for (let i = a; i < b; i++) {
    for (const x of [r.L[i] as number, r.R[i] as number]) {
      if (!Number.isFinite(x)) bad++;
      else {
        if (Math.abs(x) > peak) peak = Math.abs(x);
        dc += x;
      }
    }
  }
  return { peak, bad, dc: dc / Math.max(1, 2 * (b - a)) };
}
