import { describe, expect, it } from 'vitest';
import { runEffect, type TestParams, type TestSignal } from '@agstudio/sdk/testing';
import { gateOpen, StutterKernel } from './kernel';
import { stutterParams } from './params';

const SR = 48000;
const BEAT = SR / 2; // 120 BPM
type Params = TestParams<typeof stutterParams>;
const playing = { playing: true, bpm: 120, beat: 0 };
const run = (params: Params, x: TestSignal, frames: number, transport = playing) =>
  runEffect(StutterKernel, stutterParams, x, frames, { params, transport })[0];
const crossings = (a: Float32Array, from: number, to: number) => {
  let z = 0;
  for (let i = from + 1; i < to; i++) if ((a[i - 1] as number) < 0 && (a[i] as number) >= 0) z++;
  return z;
};

describe('StutterKernel', () => {
  it('names its gate patterns on the beat grid', () => {
    expect(gateOpen(2, 0.1)).toBe(true); // 1/8: first half of each 1/8
    expect(gateOpen(2, 0.3)).toBe(false);
    expect(gateOpen(4, 0.25)).toBe(false); // off-beat: second 1/8 of each beat only
    expect(gateOpen(4, 0.75)).toBe(true);
    expect(gateOpen(8, 0.5)).toBe(true); // half-time: one beat on, one off
    expect(gateOpen(8, 1.5)).toBe(false);
    expect(gateOpen(0, 0.3)).toBe(true);
  });

  it('gates on the beat while the song plays', () => {
    const g = run({ gate: '1/8', depth: 1, smooth: 1 }, () => 1, 2 * SR);
    const eighth = BEAT / 2;
    for (let k = 0; k < 8; k++) {
      const t0 = k * eighth;
      expect(g[t0 + eighth / 4], `1/8 #${k} on`).toBeCloseTo(1, 3);
      expect(g[t0 + (3 * eighth) / 4], `1/8 #${k} off`).toBeCloseTo(0, 3);
    }
    // Depth sets how far it cuts; a later song position shifts the pattern with it.
    const half = run({ gate: '1/8', depth: 0.5, smooth: 1 }, () => 1, SR);
    expect(half[(3 * BEAT) / 8]).toBeCloseTo(0.5, 3);
    const late = run({ gate: '1/8', depth: 1, smooth: 1 }, () => 1, SR, { ...playing, beat: 0.25 });
    expect(late[BEAT / 8]).toBeCloseTo(0, 3);
  });

  it('passes audio untouched while the song is stopped, and at 0% mix', () => {
    const x: TestSignal = (i, c) => Math.sin(i * 0.01 + c) * 0.5;
    const stopped = run({ gate: 'trance', repeat: '1/8', stop: true }, x, SR / 4, { ...playing, playing: false });
    for (let i = 0; i < stopped.length; i++) expect(stopped[i]).toBe(Math.fround(x(i, 0)));
    const dry = run({ gate: '1/16', mix: 0 }, x, SR / 4);
    for (let i = 0; i < dry.length; i++) expect(dry[i]).toBe(Math.fround(x(i, 0)));
  });

  it('beat repeat loops the slice that started on the grid', () => {
    const ramp: TestSignal = (i) => (i % 9973) / 9973 - 0.5;
    const out = run({ gate: 'off', repeat: '1/4' }, ramp, 3 * BEAT);
    // First pass live, then the beat-long slice from beat 0 again and again.
    for (const k of [1000, 5000, 20000]) {
      expect(out[k]).toBeCloseTo(ramp(k, 0), 6);
      expect(out[BEAT + k]).toBeCloseTo(ramp(k, 0), 6);
      expect(out[2 * BEAT + k]).toBeCloseTo(ramp(k, 0), 6);
    }
    // Switched on mid-way (1.25 beats in, 1/8 slices): the slice from beat 1.0, partly from history.
    const later = run({ gate: 'off', repeat: (f) => (f >= 30000 ? 3 : 0) }, ramp, 2 * SR);
    const sliceStart = BEAT; // beat 1.0
    for (const k of [500, 6000, 11000])
      expect(later[sliceStart + BEAT / 2 + k]).toBeCloseTo(ramp(sliceStart + k, 0), 6);
  });

  it('tape stop slows the sound down to a halt, then silence', () => {
    const tone: TestSignal = (i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    const out = run({ gate: 'off', stop: (f) => (f >= BEAT ? 1 : 0), stopTime: 1 }, tone, 3 * BEAT);
    const start = Math.ceil(BEAT / 128) * 128;
    // The pitch falls: fewer and fewer zero crossings per 100 ms.
    const early = crossings(out, start, start + 4800);
    const later = crossings(out, start + 14400, start + 19200);
    expect(early).toBeGreaterThan(80);
    expect(later).toBeLessThan(early * 0.6);
    // After the stop time, silence.
    expect(Math.max(...Array.from(out.subarray(start + BEAT + 100, start + BEAT + 4000), Math.abs))).toBe(0);
  });
});
