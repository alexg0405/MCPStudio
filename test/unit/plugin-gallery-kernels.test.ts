import { describe, expect, it } from 'vitest';
import { peak, renderInstrument, rms, runEffect, paramBlock, testHost } from '@agstudio/sdk/testing';
import { BitCrusherKernel } from '../../templates/gallery/bit-crusher/kernel';
import { params as crusherParams } from '../../templates/gallery/bit-crusher/params';
import { FmBellKernel } from '../../templates/gallery/fm-bell/kernel';
import { params as bellParams } from '../../templates/gallery/fm-bell/params';
import { TapeStopKernel } from '../../templates/gallery/tape-stop/kernel';
import { params as tapeParams } from '../../templates/gallery/tape-stop/params';

/** The gallery's sound code, run the way the audio thread runs it (blocks of 128 frames, in Node). */
const SR = 48000;
const sine = (hz: number, amp = 0.5) => (i: number) => amp * Math.sin((2 * Math.PI * hz * i) / SR);

/** Counts upward zero crossings in a stretch of samples: a cheap measure of pitch. */
function crossings(x: Float32Array, from: number, to: number): number {
  let count = 0;
  for (let i = from + 1; i < to; i++) if ((x[i - 1] as number) < 0 && (x[i] as number) >= 0) count++;
  return count;
}

describe('Tape Stop', () => {
  const run = (stopAt: number, releaseAt: number, seconds: number, extra: Record<string, number> = {}) =>
    runEffect(TapeStopKernel, tapeParams, sine(440), Math.round(seconds * SR), {
      params: { stop: (frame: number) => (frame >= stopAt * SR && frame < releaseAt * SR ? 1 : 0), slowDown: 1, spinUp: 0.3, ...extra },
    })[0];

  it('passes the sound straight through, with no delay, while Stop is off', () => {
    const [left] = runEffect(TapeStopKernel, tapeParams, sine(440), SR / 2, { params: { stop: 0 } });
    for (let i = 0; i < left.length; i++) expect(left[i]).toBeCloseTo(sine(440)(i), 6);
  });

  it('slows down: the pitch falls and the sound dies away to silence, with no jump', () => {
    const out = run(0.5, 100, 3);
    const stopAt = 0.5 * SR;
    const before = crossings(out, stopAt - SR / 4, stopAt);
    const during = crossings(out, stopAt + 0.45 * SR, stopAt + 0.7 * SR);
    expect(before).toBeGreaterThan(100);
    expect(during).toBeLessThan(before * 0.75);
    expect(rms(out, stopAt + 1.5 * SR, stopAt + 2 * SR)).toBeLessThan(1e-4);
    let biggestStep = 0;
    for (let i = 1; i < out.length; i++) biggestStep = Math.max(biggestStep, Math.abs((out[i] as number) - (out[i - 1] as number)));
    // A 440 Hz sine of 0.5 never moves more than 0.029 per sample: anything near that is smooth, a click would be far more.
    expect(biggestStep).toBeLessThan(0.04);
  });

  it('spins back up and hands over to the live sound', () => {
    const out = run(0.5, 1.8, 4);
    const live = sine(440);
    for (let i = Math.round(3.2 * SR); i < out.length; i++) expect(out[i]).toBeCloseTo(live(i), 6);
    // While it spins up the sound is audible again (the tape comes back before the live sound returns).
    expect(rms(out, Math.round(1.9 * SR), Math.round(2.1 * SR))).toBeGreaterThan(0.05);
    expect(peak(out)).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('can be stopped again while it is still spinning up, and always stays finite', () => {
    const [left, right] = runEffect(TapeStopKernel, tapeParams, sine(330), 6 * SR, {
      params: { stop: (frame: number) => (Math.floor(frame / (0.35 * SR)) % 2 === 0 ? 1 : 0), slowDown: 0.4, spinUp: 0.5 },
    });
    for (const channel of [left, right]) for (let i = 0; i < channel.length; i++) expect(Number.isFinite(channel[i])).toBe(true);
    expect(peak(left)).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('reset empties the tape', () => {
    const kernel = new TapeStopKernel(testHost({ sampleRate: SR }));
    runEffect(kernel, tapeParams, sine(440), SR / 4, { params: { stop: 0 } });
    kernel.reset();
    const [left] = runEffect(kernel, tapeParams, () => 0, SR / 4, { params: { stop: (frame: number) => (frame > 100 ? 1 : 0) } });
    expect(peak(left)).toBe(0);
    expect(paramBlock(tapeParams).stop[0]).toBe(0);
  });
});

describe('Bit Crusher', () => {
  const run = (params: Record<string, number>, signal = sine(220, 0.8)) =>
    runEffect(BitCrusherKernel, crusherParams, signal, SR / 4, { params })[0];

  it('rounds to the number of levels the bits allow', () => {
    const out = run({ bits: 3, rate: 48000, mix: 1 });
    const levels = new Set(Array.from(out, (x) => Math.round(x * 4 * 1e6) / 1e6));
    // 3 bits: levels at multiples of 1/4 between -1 and 1.
    for (const level of levels) expect(Math.abs(level - Math.round(level))).toBeLessThan(1e-4);
    expect(levels.size).toBeLessThanOrEqual(9);
  });

  it('holds each sample for as long as the lower sample rate says', () => {
    const out = run({ bits: 16, rate: 6000, mix: 1 });
    let runLength = 1;
    const runs: number[] = [];
    for (let i = 1; i < 4000; i++) {
      if (out[i] === out[i - 1]) runLength++;
      else {
        runs.push(runLength);
        runLength = 1;
      }
    }
    const average = runs.reduce((a, b) => a + b, 0) / runs.length;
    expect(average).toBeGreaterThan(7.5);
    expect(average).toBeLessThan(8.5);
  });

  it('does nothing at full quality and passes the dry sound at Mix 0', () => {
    const clean = run({ bits: 16, rate: 48000, mix: 1 });
    const dry = run({ bits: 2, rate: 800, mix: 0 });
    for (let i = 0; i < 2000; i++) {
      expect(clean[i]).toBeCloseTo(sine(220, 0.8)(i), 3);
      expect(dry[i]).toBeCloseTo(sine(220, 0.8)(i), 6);
    }
  });

  it('keeps silence silent and sound finite', () => {
    expect(peak(run({ bits: 1, rate: 200, mix: 1 }, () => 0))).toBe(0);
    for (const x of run({ bits: 1, rate: 200, mix: 0.5 })) expect(Number.isFinite(x)).toBe(true);
  });
});

describe('FM Bell', () => {
  const play = (key: number, params: Record<string, number | boolean | string> = {}, seconds = 3, offAt?: number) => {
    const kernel = new FmBellKernel(testHost({ sampleRate: SR }));
    const events = [{ frame: 0, run: () => kernel.noteOn(key, 1, 1, 0, 0) }];
    if (offAt !== undefined) events.push({ frame: Math.round(offAt * SR), run: () => kernel.noteOff(1, key, 0) });
    return renderInstrument(kernel, Math.round(seconds * SR), paramBlock(bellParams, params), events)[0];
  };

  it('rings at the note’s pitch and fades away', () => {
    const out = play(69, { brightness: 0, ring: 2 }, 3);
    // With no modulation it is a plain sine at 440 Hz.
    expect(crossings(out, 0, SR)).toBeGreaterThanOrEqual(438);
    expect(crossings(out, 0, SR)).toBeLessThanOrEqual(441);
    expect(rms(out, Math.round(0.1 * SR), Math.round(0.3 * SR))).toBeGreaterThan(rms(out, Math.round(1.5 * SR), Math.round(1.7 * SR)) * 3);
  });

  it('gets brighter with more modulation and stays under 0 dBFS, even as a chord', () => {
    const plain = play(60, { brightness: 0 }, 1);
    const bright = play(60, { brightness: 6 }, 1);
    const roughness = (x: Float32Array) => {
      let sum = 0;
      for (let i = 2; i < SR / 2; i++) sum += Math.abs((x[i] as number) - 2 * (x[i - 1] as number) + (x[i - 2] as number));
      return sum;
    };
    expect(roughness(bright)).toBeGreaterThan(roughness(plain) * 1.5);
    const kernel = new FmBellKernel(testHost({ sampleRate: SR }));
    const chord = [60, 64, 67, 72, 76].map((key, n) => ({ frame: 0, run: () => kernel.noteOn(key, 1, n, 0, 0) }));
    const mixed = renderInstrument(kernel, SR, paramBlock(bellParams), chord)[0];
    expect(peak(mixed)).toBeLessThan(1);
  });

  it('is damped quickly by a note off, and frees its voice when it has faded', () => {
    const held = play(64, { ring: 8, release: 0.1 }, 2);
    const damped = play(64, { ring: 8, release: 0.1 }, 2, 0.3);
    expect(rms(damped, Math.round(1 * SR), 2 * SR)).toBeLessThan(rms(held, Math.round(1 * SR), 2 * SR) * 0.01);
    const tail = play(64, { ring: 0.2, release: 0.05 }, 3, 0.1);
    expect(peak(tail.subarray(Math.round(2 * SR)))).toBe(0);
  });

  it('is silent with no note, and every output is finite', () => {
    const kernel = new FmBellKernel(testHost({ sampleRate: SR }));
    const idle = renderInstrument(kernel, SR / 4, paramBlock(bellParams));
    expect(peak(idle[0])).toBe(0);
    const out = play(127, { ratio: 12, brightness: 8, ring: 10 }, 1);
    for (const x of out) expect(Number.isFinite(x)).toBe(true);
  });
});
