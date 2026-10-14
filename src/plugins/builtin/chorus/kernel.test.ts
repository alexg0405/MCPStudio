import { describe, expect, it } from 'vitest';
import { runEffect } from '@agstudio/sdk/testing';
import { ChorusKernel } from './kernel';
import { chorusParams } from './params';

const SR = 48000;
const tone = (i: number, c: number) => 0.5 * Math.sin((2 * Math.PI * (c ? 330 : 220) * i) / SR);
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i]!)), 0);
const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

describe('ChorusKernel', () => {
  it('passes the input untouched at 0% mix', () => {
    const [l, r] = runEffect(ChorusKernel, chorusParams, tone, SR / 4, { params: { mix: 0 } });
    for (let i = 0; i < l.length; i++) {
      expect(l[i]).toBe(Math.fround(tone(i, 0)));
      expect(r[i]).toBe(Math.fround(tone(i, 1)));
    }
  });

  it('with no drift a voice is the input delayed by exactly the Delay', () => {
    const impulse = (i: number) => (i === 1000 ? 1 : 0);
    const [l] = runEffect(ChorusKernel, chorusParams, impulse, 4000, {
      params: { depth: 0, voices: 1, delay: 12, mix: 1 },
    });
    expect(l[1000 + 576]).toBeCloseTo(1, 6);
    expect(l.reduce((n, v) => n + (Math.abs(v) > 1e-6 ? 1 : 0), 0)).toBe(1);
  });

  it('thickens a tone at a sane level, differently on each side', () => {
    const [l, r] = runEffect(ChorusKernel, chorusParams, (i) => tone(i, 0), SR, {
      params: { depth: 0.7, voices: 3, width: 1, mix: 0.5 },
    });
    expect(l.every(Number.isFinite)).toBe(true);
    const tail = (a: Float32Array) => a.subarray(SR / 2);
    expect(rms(tail(l)) / rms(Float32Array.from({ length: SR / 2 }, (_, i) => tone(i, 0)))).toBeGreaterThan(0.5);
    expect(Math.max(...Array.from(l, Math.abs))).toBeLessThan(1);
    expect(maxDiff(tail(l), tail(r))).toBeGreaterThan(0.05);
  });

  it('a synced chorus follows the song position', () => {
    const run = (beat: number, sync: string) =>
      runEffect(ChorusKernel, chorusParams, tone, SR / 2, {
        params: { sync, depth: 1, voices: 1, mix: 1 },
        transport: { playing: true, bpm: 120, beat },
      })[0];
    // A quarter-note cycle: one beat later is the same place in the cycle; half a beat isn't.
    expect(maxDiff(run(0, '1/4'), run(1, '1/4'))).toBeLessThan(1e-6);
    expect(maxDiff(run(0, '1/4'), run(0.5, '1/4'))).toBeGreaterThan(0.01);
    // Free-running ignores the song position.
    expect(maxDiff(run(0, 'off'), run(0.5, 'off'))).toBeLessThan(1e-6);
  });

  it('keeps drifting at the synced rate while the song is stopped', () => {
    const [stopped] = runEffect(ChorusKernel, chorusParams, tone, SR / 2, {
      params: { sync: '1/4', depth: 1, voices: 1, mix: 1 },
      transport: { playing: false, bpm: 120 },
    });
    const [still] = runEffect(ChorusKernel, chorusParams, tone, SR / 2, {
      params: { sync: '1/4', depth: 0, voices: 1, mix: 1 },
      transport: { playing: false, bpm: 120 },
    });
    expect(maxDiff(stopped, still)).toBeGreaterThan(0.01);
  });
});
