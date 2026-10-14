import { describe, expect, it } from 'vitest';
import { runEffect, testHost, testTransport, type TestSignal } from '@agstudio/sdk/testing';
import { AnalyzerKernel } from './kernel';
import { analyzerParams } from './params';

const SR = 48000;
type Readings = Record<string, number>;

/** Runs the analyzer and returns its output and the last readings it published. */
function analyze(x: TestSignal, seconds: number, listen = 'stereo') {
  let last: Readings = {};
  const out = runEffect(AnalyzerKernel, analyzerParams, x, Math.round(seconds * SR), {
    params: { listen },
    onPost: (msg) => (last = { ...(msg as { readings: Readings }).readings }),
  });
  return { out, readings: last };
}

const sine =
  (freq: number, amp: number, phase = 0) =>
  (i: number) =>
    amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
const rms = (a: Float32Array, from: number) =>
  Math.sqrt(a.subarray(from).reduce((s, v) => s + v * v, 0) / (a.length - from));

describe('AnalyzerKernel', () => {
  it('passes audio through untouched', () => {
    const x: TestSignal = (i, c) => Math.sin(i * 0.02 + c) * 0.7;
    const { out } = analyze(x, 0.1);
    for (let i = 0; i < out[0].length; i++) {
      expect(out[0][i]).toBe(Math.fround(x(i, 0)));
      expect(out[1][i]).toBe(Math.fround(x(i, 1)));
    }
  });

  it('measures loudness (BS.1770), true peak and correlation', () => {
    // A −20 dBFS 1 kHz sine in both channels reads −20 LUFS (−23 LUFS per channel).
    const { readings } = analyze(sine(1000, 0.1), 4);
    expect(readings.momentary).toBeCloseTo(-20, 1);
    expect(readings.shortTerm).toBeCloseTo(-20, 1);
    expect(readings.integrated).toBeCloseTo(-20, 1);
    expect(readings.correlation).toBeCloseTo(1, 3);
    // Sampled at ±45°, a quarter-rate sine's samples are 3 dB under its true peak (faded in: an
    // abrupt start would overshoot).
    const fadeIn = (i: number) => Math.min(1, i / 4800) * sine(SR / 4, 0.5, Math.PI / 4)(i);
    const tp = analyze(fadeIn, 0.5).readings;
    expect(tp.truePeak).toBeCloseTo(-6.02, 1);
    expect(tp.peakL).toBeGreaterThan(-6.2);
    // Out of phase: −1. Unrelated noise: about 0.
    expect(analyze((i, c) => (c ? -1 : 1) * sine(300, 0.3)(i), 1).readings.correlation).toBeCloseTo(-1, 3);
    let s = 7;
    const noise = new Float32Array(2 * SR).map(() => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2147483648 - 1;
    });
    const unrelated = analyze((i, c) => 0.3 * (noise[(2 * i + c) % noise.length] as number), 1).readings;
    expect(Math.abs(unrelated.correlation!)).toBeLessThan(0.1);
  });

  it('restarts the integrated loudness and peak hold when the song starts', () => {
    const kernel = new AnalyzerKernel(
      testHost({ onPost: (m) => (last = { ...(m as { readings: Readings }).readings }) }),
    );
    let last: Readings = {};
    const transport = testTransport({ playing: false });
    runEffect(kernel, analyzerParams, sine(1000, 0.5), 3 * SR, { transport });
    expect(last.integrated).toBeCloseTo(-6, 0);
    transport.playing = true;
    kernel.transportChanged();
    runEffect(kernel, analyzerParams, sine(1000, 0.05), 3 * SR, { transport });
    expect(last.integrated).toBeCloseTo(-26, 0);
    expect(last.truePeak).toBeCloseTo(-26, 0);
  });

  it('Listen modes change only what you hear', () => {
    const x: TestSignal = (i, c) => sine(60, 0.4)(i) + (c ? -1 : 1) * sine(8000, 0.2)(i);
    const mono = analyze(x, 0.5, 'mono').out;
    const side = analyze(x, 0.5, 'side').out;
    expect(rms(mono[0], SR / 4) / (0.4 * Math.SQRT1_2)).toBeCloseTo(1, 2);
    expect(rms(side[0], SR / 4) / (0.2 * Math.SQRT1_2)).toBeCloseTo(1, 2);
    const lows = analyze(x, 0.5, 'lows');
    const highs = analyze(x, 0.5, 'highs');
    expect(rms(lows.out[0], SR / 4) / (0.4 * Math.SQRT1_2)).toBeCloseTo(1, 1);
    expect(rms(highs.out[0], SR / 4) / (0.2 * Math.SQRT1_2)).toBeCloseTo(1, 1);
    // The meters still see the full signal.
    expect(lows.readings.correlation).toBeCloseTo(highs.readings.correlation!, 6);
  });
});
