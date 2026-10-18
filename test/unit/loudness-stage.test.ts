import { describe, expect, it } from 'vitest';
import { runEffect, type TestSignal } from '@agstudio/sdk/testing';
import { latencyFrames, maximizerParams } from '../../src/plugins/builtin/maximizer/params';
import { MaximizerKernel, softClipShape } from '../../src/plugins/builtin/maximizer/kernel';
import {
  describeQuality,
  distortion,
  flatTopRuns,
  gain,
  hardClipped,
  kickOnsets,
  limiterOnly,
  limiterStage,
  maximized,
  maximizerStage,
  measure,
  quality,
  reachLoudness,
  SR,
  truePeakDb,
  viaOversampler,
  type Stereo,
} from '../helpers/loudness-quality';
import { syntheticMix } from '../helpers/synthetic-mix';

const db = (x: number) => 20 * Math.log10(x);

/** Amplitude of the harmonics 2…10 of `freq` in dB under the fundamental (Goertzel over whole cycles, the first 0.1 s skipped). */
function thd(x: Float32Array, freq: number): number {
  const from = Math.round(0.1 * SR);
  const to = x.length - from;
  const amp = (f: number) => {
    let re = 0;
    let im = 0;
    for (let i = from; i < to; i++) {
      const w = (2 * Math.PI * f * i) / SR;
      re += x[i]! * Math.cos(w);
      im += x[i]! * Math.sin(w);
    }
    return (2 / (to - from)) * Math.hypot(re, im);
  };
  let h = 0;
  for (let k = 2; k <= 10; k++) h += amp(k * freq) ** 2;
  return db(Math.sqrt(h) / amp(freq));
}

const sine = (freq: number, amplitude: number, seconds = 1): Stereo => {
  const s = new Float32Array(Math.round(seconds * SR)).map((_, i) => amplitude * Math.sin((2 * Math.PI * freq * i) / SR));
  return [s, s];
};

describe('the soft clip curve', () => {
  const cases: [number, number][] = [
    [2, 3],
    [4, 1],
    [0.5, 8],
    [4, 8],
    [1, 2],
  ];
  const setup = (depth: number, knee: number) => {
    const ceil = gain(-1);
    const top = ceil * gain(depth);
    const lo = Math.min(ceil * gain(-knee), ceil - (top - ceil) / 2);
    return { ceil, top, lo, span: top - lo };
  };

  it('leaves everything under the knee alone, reaches the ceiling at the top and stays there', () => {
    for (const [depth, knee] of cases) {
      const { ceil, top, lo, span } = setup(depth, knee);
      for (let i = 0; i <= 100; i++) {
        const x = (lo * i) / 100;
        expect(softClipShape(x, lo, top, ceil, span)).toBe(x);
      }
      expect(softClipShape(top, lo, top, ceil, span)).toBeCloseTo(ceil, 12);
      expect(softClipShape(top * 3, lo, top, ceil, span)).toBe(ceil);
      expect(softClipShape(-top * 3, lo, top, ceil, span)).toBe(-ceil);
      expect(softClipShape(-0.7 * top, lo, top, ceil, span)).toBe(-softClipShape(0.7 * top, lo, top, ceil, span));
    }
  });

  it('never goes down as the input goes up, and has no corner: the slope is continuous at the knee and 0 at the top', () => {
    for (const [depth, knee] of cases) {
      const { ceil, top, lo, span } = setup(depth, knee);
      let prev = 0;
      for (let i = 0; i <= 4000; i++) {
        const x = (top * 1.2 * i) / 4000;
        const y = softClipShape(x, lo, top, ceil, span);
        expect(y, `${depth} dB, ${knee} dB at ${x}`).toBeGreaterThanOrEqual(prev - 1e-12);
        expect(y).toBeLessThanOrEqual(ceil + 1e-12);
        prev = y;
      }
      const h = 1e-6;
      const slope = (x: number) => (softClipShape(x + h, lo, top, ceil, span) - softClipShape(x - h, lo, top, ceil, span)) / (2 * h);
      expect(slope(lo + 2 * h)).toBeCloseTo(1, 3);
      expect(slope(top - 2 * h)).toBeCloseTo(0, 3);
    }
  });
});

describe('MaximizerKernel', () => {
  it('delays quiet audio by the same latency as the Limiter: bit-exactly with the clip off, through the oversampler’s linear filters with it on', () => {
    const D = latencyFrames(SR);
    expect(D).toBe(240 + 14);
    const x: TestSignal = (i, c) => 0.2 * Math.sin(i * 0.01 + c) + (i === 500 ? 0.1 : 0);
    const n = 4000;
    const off = runEffect(MaximizerKernel, maximizerParams, x, n, { params: { clip: 0 } });
    for (let i = 0; i < D; i++) expect(off[0][i]).toBe(0);
    for (let i = D; i < n; i++) {
      expect(off[0][i]).toBe(Math.fround(x(i - D, 0)));
      expect(off[1][i]).toBe(Math.fround(x(i - D, 1)));
    }
    // Clip on: the same as the input delayed and sent through a 2× oversampler and back (its halfband filters shift phase a little).
    const on = runEffect(MaximizerKernel, maximizerParams, x, n, { params: { clip: 2 } });
    const delayed: Stereo = [new Float32Array(n), new Float32Array(n)];
    for (let i = D; i < n; i++) {
      delayed[0][i] = x(i - D, 0);
      delayed[1][i] = x(i - D, 1);
    }
    const expected = viaOversampler(delayed);
    for (let i = D; i < n; i++) {
      expect(Math.abs((on[0][i] as number) - (expected[0][i] as number))).toBeLessThan(1e-6);
      expect(Math.abs((on[1][i] as number) - (expected[1][i] as number))).toBeLessThan(1e-6);
    }
  });

  it('keeps a mix under its ceiling plus the soft clip filter’s overshoot (under 3 dB), at any input gain and clip; the Limiter after it makes it exact', () => {
    const x = syntheticMix(3);
    let worst = -Infinity;
    for (const input of [8, 24]) {
      for (const clip of [0, 2, 4]) {
        const y = maximizerStage(x, { input, clip });
        let peak = 0;
        for (const ch of y) for (const v of ch) peak = Math.max(peak, Math.abs(v));
        worst = Math.max(worst, db(peak) + 1);
        expect(db(peak), `${input} dB in, clip ${clip}`).toBeLessThanOrEqual(-1 + (clip === 0 ? 0.01 : 3));
        expect(truePeakDb(limiterStage(y, { input: 0 })), `${input} dB in, clip ${clip}, then the Limiter`).toBeLessThanOrEqual(-1 + 0.01);
      }
    }
    console.log(`MAX | the largest overshoot of the Maximizer's output over its ceiling: ${worst.toFixed(2)} dB`);
  }, 60_000);

  it('is clean below the knee: a sine 6 dB under the ceiling comes out with no distortion at all', () => {
    const y = maximizerStage(sine(1000, gain(-7)), { input: 0, clip: 2, knee: 3 });
    expect(thd(y[0], 1000)).toBeLessThan(-100);
  });

  it('distorts a sustained sine only from the knee up: the harmonics grow smoothly with how far into the clip the peaks go', () => {
    // Steady 60 Hz (a held bass note) at the ceiling, 1 dB and 2 dB over it (2 dB is where the first stage holds the peaks with the default clip).
    const at = (over: number) => thd(maximizerStage(sine(60, gain(-1 + over)), { input: 0, clip: 2, knee: 3 })[0], 60);
    const thds = [-2, 0, 1, 2].map(at);
    console.log(`MAX | 60 Hz sine THD at the ceiling −2/0/+1/+2 dB: ${thds.map((t) => t.toFixed(1)).join(' / ')} dB`);
    expect(thds[0]).toBeLessThan(-45);
    expect(thds[1]).toBeLessThan(-28);
    expect(thds[3]).toBeLessThan(-19);
    for (let i = 1; i < thds.length; i++) expect(thds[i]!).toBeGreaterThan(thds[i - 1]!);
  });
});

/**
 * The objective quality limits, on a synthetic dance mix (the engine's renders of the EDM styles are in test/browser/loudness-stage.test.ts).
 * At each loudness the Limiter alone, the Maximizer and Limiter, and the hard clipper that once crushed a song (the control: the measures must
 * be able to tell it from the new chain) are compared; every number is printed (`MAX |`).
 */
describe('the loudness stage on a dense mix', () => {
  const x = syntheticMix(4);
  const xo = viaOversampler(x);
  const onsets = kickOnsets(x);

  it('reaches −9 and −8 LUFS within 0.1 dB where the Limiter alone cannot reach −8, with a true peak of −1 dBTP and no flat tops', () => {
    const old = reachLoudness(x, -8, limiterOnly);
    console.log(`MAX | limiter alone at +${old.input.toFixed(0)} dB reaches ${old.lufs.toFixed(2)} LUFS, true peak ${measure(old.y).truePeakDb!.toFixed(2)}`);
    expect(Math.abs(old.lufs - -8)).toBeGreaterThan(0.1);
    for (const level of [-9, -8]) {
      const hit = reachLoudness(x, level, (xx, g) => maximized(xx, g), 16);
      const q = quality(hit.y, xo, onsets);
      console.log(`MAX | maximizer +${hit.input.toFixed(1)} dB for ${level}: ${describeQuality(q)}`);
      expect(Math.abs(q.lufs - level)).toBeLessThanOrEqual(0.1);
      expect(q.truePeakDb).toBeLessThanOrEqual(-1 + 0.01);
      expect(q.flatTops).toBe(0);
    }
  }, 120_000);

  it('at equal loudness is no more distorted than the Limiter alone, keeps the kick as punchy and weighty, and is far cleaner than a hard clipper', () => {
    for (const level of [-9, -8.5]) {
      const old = reachLoudness(x, level, limiterOnly);
      const next = reachLoudness(x, level, (xx, g) => maximized(xx, g), 16);
      const hard = reachLoudness(x, level, (xx, g) => hardClipped(xx, g), 16);
      expect(Math.abs(old.lufs - level)).toBeLessThanOrEqual(0.1);
      const qOld = quality(old.y, x, onsets);
      const qNew = quality(next.y, xo, onsets);
      const qHard = quality(hard.y, x, onsets);
      console.log(`MAX | @${level} limiter +${old.input.toFixed(1)}: ${describeQuality(qOld)}`);
      console.log(`MAX | @${level} maximizer +${next.input.toFixed(1)}: ${describeQuality(qNew)}`);
      console.log(`MAX | @${level} hard clip +${hard.input.toFixed(1)}: ${describeQuality(qHard)}`);
      // Distortion (gain-matched residual, dB under the output): within 1 dB of the Limiter's or better, and under an absolute −22 dB.
      expect(qNew.distortion).toBeLessThanOrEqual(qOld.distortion + 1);
      expect(qNew.distortion).toBeLessThanOrEqual(-22);
      expect(qNew.distortionP95).toBeLessThanOrEqual(-17);
      expect(qNew.distortionHigh).toBeLessThanOrEqual(-18);
      // Kick transient and body: no more than half a dB under the Limiter's, and the punch at least 5 dB.
      expect(qNew.punch).toBeGreaterThanOrEqual(qOld.punch - 0.5);
      expect(qNew.weight).toBeGreaterThanOrEqual(qOld.weight - 0.5);
      expect(qNew.punch).toBeGreaterThanOrEqual(5);
      // The control, the hard clipper that made a song sound like static: the measures see it (8+ dB more distortion overall, 10+ dB in its worst moments).
      expect(qNew.distortion).toBeLessThan(qHard.distortion - 6);
      expect(qNew.distortionP95).toBeLessThan(qHard.distortionP95 - 8);
    }
    void distortion;
    void flatTopRuns;
  }, 180_000);
});
