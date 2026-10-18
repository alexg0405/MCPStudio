/**
 * The drawn table ("My table") through the whole path: state → bank (`onState`, off the audio thread) → kernel. Covers
 * the sound of a user table, morphing, aliasing at high notes (energy that is not a harmonic stays far below the
 * signal), the state migration from version 1 and the presets that carry a table.
 */
import { describe, expect, it } from 'vitest';
import type { ParamValue, WorkletPort } from '@agstudio/sdk';
import { WavetableBank } from '@agstudio/sdk/dsp/wavetable';
import {
  buildFrameBank,
  decodeFrame,
  EMPTY_TABLE_STATE,
  frameFromHarmonics,
  frameFromWave,
  framesOfState,
  userTableState,
  type UserTableState,
} from '@agstudio/sdk/dsp/wavetable-frames';
import { paramBlock, peak, renderInstrument, rms, testHost, testTransport } from '@agstudio/sdk/testing';
import wavetable from './index';
import { WavetableKernel } from './kernel';
import { wavetableParams } from './params';
import { syncUserTable } from './table-sync';
import { factoryBank } from './tables';

const SR = 48000;

/** A kernel fed the way the plugin feeds it: the factory bank, then whatever `onState` sends for the state. */
function kernelFor(state: UserTableState | undefined) {
  const k = new WavetableKernel(testHost(SR, 3));
  k.useBank(factoryBank());
  k.transport = testTransport({ playing: true, bpm: 120, sampleRate: SR });
  const sends: unknown[] = [];
  const port = { send: (m: unknown) => sends.push(m) } as unknown as WorkletPort;
  syncUserTable(state, port);
  for (const m of sends) k.onMessage(m);
  return { k, sends, port };
}

const PLAIN: Record<string, ParamValue> = { velocity: 0, keyTrack: 0, cutoff: 20000, resonance: 0, osc1Table: 'user' };

function play(state: UserTableState | undefined, values: Record<string, ParamValue>, key: number, seconds = 1) {
  const { k } = kernelFor(state);
  return renderInstrument(k, Math.round(seconds * SR), paramBlock(wavetableParams, { ...PLAIN, ...values }), [
    { frame: 0, run: () => k.noteOn(key, 1, 1, 0, 0) },
  ])[0] as Float32Array;
}

function freq(x: Float32Array, from: number, to: number): number {
  const c: number[] = [];
  for (let i = Math.max(1, from); i < to; i++) {
    const a = x[i - 1] as number;
    const b = x[i] as number;
    if (a < 0 && b >= 0) c.push(i - 1 + a / (a - b));
  }
  return c.length < 2 ? 0 : ((c.length - 1) * SR) / ((c[c.length - 1] as number) - (c[0] as number));
}

function brightness(x: Float32Array, from: number, to: number): number {
  let e = 0;
  let d = 0;
  for (let i = from + 1; i < to; i++) {
    e += (x[i] as number) ** 2;
    d += ((x[i] as number) - (x[i - 1] as number)) ** 2;
  }
  return d / Math.max(1e-12, e);
}

describe('Wavetable: the user table in the kernel', () => {
  it('a drawn table plays in tune, at its own shape', () => {
    // A fundamental and an octave: the shape is not a sine, but it repeats at the note's pitch.
    const state = userTableState([frameFromHarmonics([1, 0.5])]);
    const x = play(state, { osc1Position: 0 }, 69);
    expect(freq(x, 4800, SR)).toBeCloseTo(440, 0);
    expect(brightness(x, 4800, SR)).toBeGreaterThan(brightness(play(undefined, {}, 69), 4800, SR) * 1.4);
  });

  it('with no table drawn yet, "My table" is a sine (and nothing breaks)', () => {
    const x = play(undefined, {}, 69);
    expect(freq(x, 4800, SR)).toBeCloseTo(440, 0);
    expect(rms(x, 4800)).toBeGreaterThan(0.05);
    expect(peak(x)).toBeLessThan(1);
    // The same as a drawn pure sine.
    const sine = play(userTableState([frameFromHarmonics([1])]), {}, 69);
    expect(Math.abs(rms(x, 4800) - rms(sine, 4800))).toBeLessThan(1e-3);
  });

  it('position morphs through the key frames, each at the same peak level', () => {
    const state = userTableState([frameFromHarmonics([1]), frameFromHarmonics([1, 1, 1, 1, 1, 1, 1, 1])]);
    const start = play(state, { osc1Position: 0 }, 57);
    const end = play(state, { osc1Position: 1 }, 57);
    const mid = play(state, { osc1Position: 0.5 }, 57);
    expect(brightness(end, 4800, SR)).toBeGreaterThan(brightness(start, 4800, SR) * 10);
    const b = (x: Float32Array) => brightness(x, 4800, SR);
    expect(b(mid)).toBeGreaterThan(b(start));
    expect(b(mid)).toBeLessThan(b(end));
    expect(peak(start, 4800)).toBeGreaterThan(0.05);
    // The mod matrix moves it like a factory table's position.
    const swept = play(state, { osc1Position: 0, mod1Source: 'modWheel', mod1Target: 'osc1Position', mod1Amount: 1 }, 57);
    expect(Number.isFinite(rms(swept))).toBe(true);
  });

  it('the second oscillator can use it too, and both can differ in position', () => {
    const state = userTableState([frameFromHarmonics([1]), frameFromHarmonics([0, 0, 1])]);
    const both = play(state, { osc1Position: 0, osc2Table: 'user', osc2Position: 1, osc2Level: 0.8, osc2Coarse: 12 }, 57);
    const one = play(state, { osc1Position: 0 }, 57);
    expect(rms(both, 4800)).toBeGreaterThan(rms(one, 4800));
  });

  it('a factory table still plays on an instance that has a drawn table', () => {
    const state = userTableState([frameFromHarmonics([1, 1, 1, 1])]);
    const plain = play(undefined, { osc1Table: 'basic', osc1Position: 1 }, 57);
    const withTable = play(state, { osc1Table: 'basic', osc1Position: 1 }, 57);
    expect(withTable).toEqual(plain);
  });

  it('replacing the table while it sounds switches shape without NaNs or a stop', () => {
    const { k } = kernelFor(userTableState([frameFromHarmonics([1])]));
    const bright = buildFrameBank([frameFromHarmonics([1, 1, 1, 1, 1, 1, 1, 1])]);
    const [l] = renderInstrument(
      k,
      SR,
      paramBlock(wavetableParams, { ...PLAIN, osc1Position: 0, ampSustain: 1 }),
      [
        { frame: 0, run: () => k.noteOn(60, 1, 1, 0, 0) },
        { frame: SR / 2, run: () => k.onMessage({ type: 'userBank', data: bright.data, frames: bright.frames }) },
      ],
    );
    const x = l as Float32Array;
    expect(x.every(Number.isFinite)).toBe(true);
    expect(brightness(x, SR - 4800, SR)).toBeGreaterThan(brightness(x, 4800, 9600) * 10);
    expect(rms(x, SR - 4800, SR)).toBeGreaterThan(0.02);
  });

  it('refuses bank data that is too short for what it claims, and keeps playing', () => {
    const { k } = kernelFor(userTableState([frameFromHarmonics([1])]));
    expect(() => k.onMessage({ type: 'userBank', data: new Float32Array(10), frames: 8 })).not.toThrow();
    expect(() => k.onMessage({ type: 'userBank', frames: 2 })).not.toThrow();
    expect(() => k.onMessage(null)).not.toThrow();
    const [l] = renderInstrument(k, 4800, paramBlock(wavetableParams, PLAIN), [{ frame: 0, run: () => k.noteOn(60, 1, 1, 0, 0) }]);
    expect(rms(l as Float32Array, 1000)).toBeGreaterThan(0.05);
  });
});

describe('Wavetable: aliasing of a drawn table at high notes', () => {
  // A hand-drawn square wave (hard edges: harmonics all the way up) is the worst case for aliasing.
  const wave = Float32Array.from({ length: 1024 }, (_, i) => (i < 512 ? 1 : -1));
  const state = userTableState([frameFromWave(wave)]);

  /** Energy (dB re total) of everything farther than a few bins from a multiple of f0. */
  function nonHarmonicDb(x: Float32Array, f0: number): number {
    const n = 16384;
    const start = 8192;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    // A 4-term Blackman-Harris window (sidelobes below −92 dB): leakage from the strong harmonics must not count as aliasing.
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n;
      const w = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
      re[i] = (x[start + i] as number) * w;
    }
    fftInPlace(re, im);
    const bin = n / SR;
    let total = 0;
    let off = 0;
    for (let k = 1; k < n / 2; k++) {
      const p = (re[k] as number) ** 2 + (im[k] as number) ** 2;
      total += p;
      const h = (k / bin) / f0;
      if (Math.abs(h - Math.round(h)) * f0 * bin > 6) off += p;
    }
    return 10 * Math.log10(off / total);
  }

  it.each([84, 96, 108])('key %i: nothing but harmonics (the energy between them is far below −60 dB)', (key) => {
    const x = play(state, { osc1Position: 0 }, key, 0.6);
    const f0 = 440 * Math.pow(2, (key - 69) / 12);
    expect(nonHarmonicDb(x, f0)).toBeLessThan(-60);
  });

  it('the same table read without its mip levels would alias (the test can tell)', () => {
    const bank = buildFrameBank([frameFromWave(wave)]);
    const key = 108;
    const f0 = 440 * Math.pow(2, (key - 69) / 12);
    const x = new Float32Array(32768);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      x[i] = bank.sample(0, 0, ph, 0);
      ph = (ph + f0 / SR) % 1;
    }
    expect(nonHarmonicDb(x, f0)).toBeGreaterThan(-45);
    expect(WavetableBank.levelFor(f0 / SR)).toBeGreaterThan(2);
  });
});

describe('Wavetable: state and presets', () => {
  it('opens a version-1 project: its params stay, its state becomes an empty table', () => {
    const old = wavetable.migrate!({ version: 1, params: { cutoff: 800, osc1Table: 'vocal' }, state: undefined });
    expect(old.params).toEqual({ cutoff: 800, osc1Table: 'vocal' });
    expect(old.state).toEqual(EMPTY_TABLE_STATE);
    expect(wavetable.version).toBe(2);
    expect(wavetable.defaultState).toEqual(EMPTY_TABLE_STATE);
  });

  it('migrates damaged state to an empty table and keeps what still decodes', () => {
    for (const bad of [null, 7, 'x', { user: 'no' }, { v: 2, user: { frames: [1, 2, 'zz'] } }])
      expect(wavetable.migrate!({ version: 1, params: {}, state: bad }).state).toEqual(EMPTY_TABLE_STATE);
    const good = userTableState([frameFromHarmonics([1, 0.5])]);
    const kept = wavetable.migrate!({ version: 1, params: {}, state: { ...good, junk: true } }).state;
    expect(kept).toEqual(good);
  });

  it('builds the bank once per table: the same state again sends nothing, a change sends a new bank', () => {
    const { sends, port } = kernelFor(userTableState([frameFromHarmonics([1])]));
    expect(sends).toHaveLength(1);
    syncUserTable(userTableState([frameFromHarmonics([1])]), port);
    expect(sends).toHaveLength(1);
    syncUserTable(userTableState([frameFromHarmonics([1, 1])]), port);
    expect(sends).toHaveLength(2);
    const m = sends[1] as { type: string; data: Float32Array; frames: number };
    expect(m.type).toBe('userBank');
    expect(m.frames).toBe(1);
    // Back to no table: the one-sine bank.
    syncUserTable(EMPTY_TABLE_STATE, port);
    expect(sends).toHaveLength(3);
    // An old project's state may be missing altogether.
    expect(() => syncUserTable(undefined as never, port)).not.toThrow();
  });

  it('every preset that carries a table has valid frames, uses the table, and sounds', () => {
    const drawn = (wavetable.presets ?? []).filter((p) => p.state);
    expect(drawn.length).toBeGreaterThanOrEqual(4);
    for (const preset of drawn) {
      const frames = framesOfState(preset.state);
      expect(frames.length, preset.name).toBeGreaterThanOrEqual(3);
      for (const f of preset.state!.user!.frames) expect(decodeFrame(f), preset.name).not.toBeNull();
      expect(preset.params?.osc1Table, preset.name).toBe('user');
      const { k } = kernelFor(preset.state);
      const events = [60, 67].map((key, i) => ({ frame: 0, run: () => k.noteOn(key, 0.8, i + 1, 0, 0) }));
      const [l, r] = renderInstrument(
        k,
        SR,
        paramBlock(wavetableParams, (preset.params ?? {}) as Record<string, ParamValue>),
        events,
      );
      for (const ch of [l, r] as Float32Array[]) expect(ch.every(Number.isFinite), preset.name).toBe(true);
      expect(rms(l as Float32Array, 2400), preset.name).toBeGreaterThan(0.005);
      expect(peak(l as Float32Array), preset.name).toBeLessThan(0.95);
    }
  });
});

/** An FFT for the tests' spectra (the SDK's is covered by its own tests). */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (-2 * Math.PI) / size;
    for (let s = 0; s < n; s += size)
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = s + k;
        const b = a + size / 2;
        const tr = (re[b] as number) * wr - (im[b] as number) * wi;
        const ti = (re[b] as number) * wi + (im[b] as number) * wr;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
  }
}
