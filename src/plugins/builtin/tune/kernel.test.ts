import { describe, expect, it } from 'vitest';
import { SCALES } from '@agstudio/sdk/notes';
import { Yin } from '@agstudio/sdk/worklet';
import { runEffect, type TestParams, type TestSignal } from '@agstudio/sdk/testing';
import { nearestNote, TuneKernel } from './kernel';
import { TUNE_SCALES, tuneLatencyFrames, tuneParams } from './params';

const SR = 48000;
const D = tuneLatencyFrames(SR);
type Params = TestParams<typeof tuneParams>;
const sine =
  (freq: number, amp = 0.4) =>
  (i: number) =>
    amp * Math.sin((2 * Math.PI * freq * i) / SR);
const cents = (f: number, ref: number) => 1200 * Math.log2(f / ref);

/** Median pitch of a signal over [from, to), by YIN every 5 ms. */
function pitchOf(x: Float32Array, from: number, to: number): number {
  const yin = new Yin(SR, { minHz: 80, maxHz: 1000 });
  const found: number[] = [];
  for (let i = 0; i < to; i++) {
    yin.push(x[i] as number);
    if (i >= from && i % 240 === 0 && yin.detect() > 0) found.push(yin.frequency);
  }
  found.sort((a, b) => a - b);
  return found[Math.floor(found.length / 2)] ?? 0;
}

const tune = (x: TestSignal, params: Params, seconds = 1) =>
  runEffect(TuneKernel, tuneParams, x, Math.round(seconds * SR), { params })[0];

describe('TuneKernel', () => {
  it('its scales are the SDK’s SCALES (ids, labels, intervals, order)', () => {
    expect(TUNE_SCALES.map((s) => s.id)).toEqual(SCALES.map((s) => s.id));
    expect(TUNE_SCALES.map((s) => s.label)).toEqual(SCALES.map((s) => s.label));
    expect(TUNE_SCALES.map((s) => [...s.intervals])).toEqual(SCALES.map((s) => [...s.intervals]));
    expect(tuneParams.scale.options).toEqual(SCALES.map((s) => s.id));
  });

  it('snaps a slightly sharp A to 440 Hz (chromatic, instant)', () => {
    const out = tune(sine(446), { key: 'A', scale: 'chromatic', speed: 0 });
    expect(Math.abs(cents(pitchOf(out, SR / 2, SR), 440))).toBeLessThan(3);
  });

  it('a slow retune speed gets there later', () => {
    const fast = tune(sine(446), { scale: 'chromatic', speed: 0 }, 0.3);
    const slow = tune(sine(446), { scale: 'chromatic', speed: 300 }, 0.3);
    const early = (x: Float32Array) => Math.abs(cents(pitchOf(x, 0.15 * SR, 0.3 * SR), 440));
    expect(early(fast)).toBeLessThan(5);
    expect(early(slow)).toBeGreaterThan(8);
  });

  it('pulls to the key’s scale: in C major a sharp C# goes to D', () => {
    expect(nearestNote(61.1, 0, 0b101010110101, -1)).toBe(62);
    expect(nearestNote(61.4, 0, 0b101010110101, -1)).toBe(62);
    // Hysteresis: a note held near the middle doesn't flip.
    expect(nearestNote(61.05, 0, 0b101010110101, 60)).toBe(60);
    const out = tune(sine(277.18 * Math.pow(2, 10 / 1200)), { key: 'C', scale: 'major', speed: 0 });
    expect(Math.abs(cents(pitchOf(out, SR / 2, SR), 293.66))).toBeLessThan(3);
    // Splices line up with the waveform: the level stays steady (no dips while shifting).
    const levels: number[] = [];
    for (let from = SR / 2; from + 480 <= SR; from += 480) {
      let sum = 0;
      for (let i = from; i < from + 480; i++) sum += (out[i] as number) ** 2;
      levels.push(10 * Math.log10(sum / 480));
    }
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(1);
  });

  it('mix 0 is the input, delayed by the reported latency', () => {
    const x = sine(300);
    const out = tune(x, { mix: 0 }, 0.2);
    for (let i = D; i < out.length; i += 7) expect(out[i]).toBeCloseTo(x(i - D), 6);
  });

  it('in tune (or unpitched) it passes the input through, delayed; noise never blows up', () => {
    const x = sine(440);
    const out = tune(x, { key: 'A', scale: 'chromatic', speed: 50 }, 1);
    let worst = 0;
    for (let i = SR / 2; i < SR; i++) worst = Math.max(worst, Math.abs((out[i] as number) - x(i - D)));
    expect(worst).toBeLessThan(0.01);
    let s = 5;
    const noise: TestSignal = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2147483648 - 1;
    };
    const n = tune(noise, { speed: 0 }, 1);
    expect(n.every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from(n, Math.abs))).toBeLessThan(2.5);
  });
});
