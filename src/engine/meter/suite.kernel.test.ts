/**
 * Accuracy of the metering suite against the EBU conformance cases that can be synthesized (EBU Tech 3341 for
 * momentary, short-term, integrated loudness and true peak; Tech 3342 for loudness range), plus stereo correlation,
 * width, the spectrum scale and the controls. These run the real kernel the worklet runs, on plain arrays.
 */
import { describe, expect, it } from 'vitest';
import { cpuNow, settle } from '@agstudio/sdk/testing';
import { HISTORY_CAPACITY, plainViews, R, SCOPE_FRAMES, SPECTRUM_SIZE, type MeterViews } from './layout';
import { MeterKernel } from './suite.kernel';

const SR = 48000;
const db = (x: number) => 10 ** (x / 20);

type Gen = (i: number, ch: number) => number;

/** Feeds `seconds` of a generator through the kernel in render quanta (the frame index counts on from `from`). */
function feed(k: MeterKernel, gen: Gen, seconds: number, from = 0, sr = SR): number {
  const frames = Math.round(seconds * sr);
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  for (let start = 0; start < frames; start += 128) {
    const n = Math.min(128, frames - start);
    for (let i = 0; i < n; i++) {
      l[i] = gen(from + start + i, 0);
      r[i] = gen(from + start + i, 1);
    }
    k.process(l, r, n);
  }
  return from + frames;
}

/** A 1 kHz sine of this peak level (dBFS) in both channels: stereo, so its loudness is its level in LUFS. */
const tone =
  (level: number, hz = 1000, sr = SR): Gen =>
  (i) =>
    db(level) * Math.sin((2 * Math.PI * hz * i) / sr);

function made(sr = SR): { k: MeterKernel; v: MeterViews } {
  const v = plainViews();
  return { k: new MeterKernel(sr, v), v };
}

/** Plays a pattern of [level dBFS, seconds] segments of the 1 kHz tone; returns the readings view. */
function pattern(segments: readonly (readonly [number, number])[]): MeterViews {
  const { k, v } = made();
  let at = 0;
  for (const [level, seconds] of segments) at = feed(k, tone(level), seconds, at);
  return v;
}

describe('loudness (EBU Tech 3341)', () => {
  it('case 1: a stereo 1 kHz sine at −23 dBFS reads −23.0 LUFS momentary, short-term and integrated', () => {
    const v = pattern([[-23, 20]]);
    expect(v.readings[R.momentary]).toBeCloseTo(-23, 1);
    expect(v.readings[R.shortTerm]).toBeCloseTo(-23, 1);
    expect(v.readings[R.integrated]).toBeCloseTo(-23, 1);
    expect(v.readings[R.maxMomentary]).toBeCloseTo(-23, 1);
    expect(v.readings[R.maxShortTerm]).toBeCloseTo(-23, 1);
  });

  it('case 2: the same at −33 dBFS reads −33.0', () => {
    const v = pattern([[-33, 20]]);
    expect(v.readings[R.integrated]).toBeCloseTo(-33, 1);
    expect(v.readings[R.shortTerm]).toBeCloseTo(-33, 1);
  });

  it('case 3: 10 s at −36, 60 s at −23, 10 s at −36 integrates to −23.0 (the relative gate drops the quiet parts)', () => {
    const v = pattern([
      [-36, 10],
      [-23, 60],
      [-36, 10],
    ]);
    expect(v.readings[R.integrated]).toBeCloseTo(-23, 1);
  });

  it('case 4: a part under −70 LUFS never counts (the absolute gate)', () => {
    const v = pattern([
      [-80, 30],
      [-23, 30],
    ]);
    expect(v.readings[R.integrated]).toBeCloseTo(-23, 1);
    // Only gated audio: nothing to report.
    expect(pattern([[-80, 20]]).readings[R.integrated]).toBe(-Infinity);
  });

  it('case 5: two levels 6 LU apart gate against each other as the spec says (−26 and −20, equal time)', () => {
    // Ungated mean of equal times at −26 and −20: 10·log10((10^−2.6 + 10^−2)/2) − 0.691 offsets cancel to −23.0 − (a bit).
    // The relative gate sits 10 LU under it (≈ −30.0 LUFS), under both parts, so both count.
    const v = pattern([
      [-26, 20],
      [-20, 20],
    ]);
    const expected = 10 * Math.log10((10 ** -2.6 + 10 ** -2) / 2);
    expect(v.readings[R.integrated]).toBeCloseTo(expected, 1);
  });

  it('momentary rises in 400 ms and short-term in 3 s: a step from silence reads its level once the window is full', () => {
    const { k, v } = made();
    const at = feed(k, tone(-23), 0.5);
    expect(v.readings[R.momentary]).toBeCloseTo(-23, 1);
    expect(v.readings[R.shortTerm]).toBe(-Infinity);
    feed(k, tone(-23), 3, at);
    expect(v.readings[R.shortTerm]).toBeCloseTo(-23, 1);
  });

  it('a mono (one channel) sine at −20 dBFS reads −23 LUFS, and silence reads −Infinity', () => {
    const { k, v } = made();
    feed(k, (i, ch) => (ch === 0 ? db(-20) * Math.sin((2 * Math.PI * 1000 * i) / SR) : 0), 10);
    expect(v.readings[R.integrated]).toBeCloseTo(-23, 1);
    const s = made();
    feed(s.k, () => 0, 5);
    expect(s.v.readings[R.momentary]).toBe(-Infinity);
    expect(s.v.readings[R.integrated]).toBe(-Infinity);
  });

  it('works at 44.1 kHz and 96 kHz too', () => {
    for (const sr of [44100, 96000]) {
      const { k, v } = made(sr);
      feed(k, tone(-23, 1000, sr), 10, 0, sr);
      expect(v.readings[R.integrated], `${sr}`).toBeCloseTo(-23, 1);
    }
  });

  it('a reset restarts the integrated loudness and the maximums (the next audio is a new measurement)', () => {
    const { k, v } = made();
    const at = feed(k, tone(-14), 10);
    expect(v.readings[R.integrated]).toBeCloseTo(-14, 1);
    v.readings[R.resetSeq] = 1;
    feed(k, tone(-30), 10, at);
    expect(v.readings[R.integrated]).toBeCloseTo(-30, 1);
    expect(v.readings[R.maxMomentary]).toBeCloseTo(-30, 1);
    expect(v.readings[R.truePeakL]).toBeLessThan(-29);
  });
});

describe('loudness range (EBU Tech 3342)', () => {
  const lra = (segments: readonly (readonly [number, number])[]) => pattern(segments).readings[R.range] as number;

  it('case 1: 20 s at −20 and 20 s at −30 LUFS: 10 LU (±1)', () => {
    expect(lra([[-20, 20], [-30, 20]])).toBeCloseTo(10, 0);
  });
  it('case 2: −20 and −15: 5 LU (±1)', () => {
    expect(lra([[-20, 20], [-15, 20]])).toBeCloseTo(5, 0);
  });
  it('case 3: −40 and −20: 20 LU (±1)', () => {
    expect(lra([[-40, 20], [-20, 20]])).toBeCloseTo(20, 0);
  });
  it('case 4: −50, −35, −20, −35, −50 (20 s each): 15 LU (±1; the −50 parts fall under the relative gate)', () => {
    expect(lra([[-50, 20], [-35, 20], [-20, 20], [-35, 20], [-50, 20]])).toBeCloseTo(15, 0);
  });
  it('a steady tone has no range, and a short clip has none yet', () => {
    expect(lra([[-23, 30]])).toBeLessThan(0.2);
    expect(lra([[-23, 2]])).toBe(0);
  });
});

describe('true peak (EBU Tech 3341, cases 15 to 19)', () => {
  /** A sine at a quarter of the sample rate and 45°: every sample is ±0.707·A but the wave reaches A between them. */
  const quarter =
    (amp: number, phase = Math.PI / 4): Gen =>
    (i) =>
      amp * Math.sin((Math.PI / 2) * i + phase);

  it('an inter-sample peak at fs/4, 45°: the sample peak is 3 dB under the true peak, and the meter finds it within 0.2 dB', () => {
    for (const level of [0, -3, -6, -12]) {
      const { k, v } = made();
      feed(k, quarter(db(level)), 1);
      const tp = v.readings[R.truePeakL] as number;
      expect(tp, `${level} dBTP`).toBeGreaterThan(level - 0.2);
      expect(tp, `${level} dBTP`).toBeLessThan(level + 0.2);
    }
  });

  it('measures each channel on its own', () => {
    const { k, v } = made();
    feed(k, (i, ch) => (ch === 0 ? quarter(db(-6))(i, 0) : quarter(db(-12))(i, 1)), 1);
    expect(v.readings[R.truePeakL]).toBeCloseTo(-6, 0);
    expect(v.readings[R.truePeakR]).toBeCloseTo(-12, 0);
  });

  it('a 997 Hz sine at −3 dBFS and a sine near the top of the band read their level within 0.2 dB, whatever the phase', () => {
    for (const [hz, level] of [
      [997, -3],
      [9000, -3],
      [11025, -6],
    ] as const) {
      for (const phase of [0.1, 0.9, 2.0, 3.5]) {
        const { k, v } = made();
        // After the first moments: the start of a sine is a step, and a step overshoots in any reconstruction.
        const at = feed(k, (i) => db(level) * Math.sin((2 * Math.PI * hz * i) / SR + phase), 0.2);
        v.readings[R.resetSeq] = 1;
        feed(k, (i) => db(level) * Math.sin((2 * Math.PI * hz * i) / SR + phase), 0.5, at);
        const tp = v.readings[R.truePeakL] as number;
        expect(Math.abs(tp - level), `${hz} Hz phase ${phase}: ${tp.toFixed(2)}`).toBeLessThan(0.2);
      }
    }
  });

  it('holds the maximum until a reset, while the current peak falls', () => {
    const { k, v } = made();
    let at = feed(k, tone(-6), 0.5);
    at = feed(k, () => 0, 1, at);
    expect(v.readings[R.truePeakL]).toBeCloseTo(-6, 0);
    expect(v.readings[R.peakL]).toBeLessThan(-20);
    v.readings[R.resetSeq] = 1;
    feed(k, () => 0, 0.1, at);
    expect(v.readings[R.truePeakL]).toBe(-Infinity);
  });
});

describe('stereo', () => {
  const noise = (seed: number) => {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s / 2 ** 32) * 2 - 1;
    };
  };

  function stereo(gen: Gen, seconds = 3) {
    const { k, v } = made();
    v.readings[R.detail] = 1;
    feed(k, gen, seconds);
    return v;
  }

  it('correlation reads +1 for the same signal, −1 for opposite polarity and about 0 for unrelated noise', () => {
    const t = tone(-12, 440);
    expect(stereo((i) => t(i, 0)).readings[R.correlation]).toBeCloseTo(1, 3);
    expect(stereo((i, ch) => (ch === 0 ? t(i, 0) : -t(i, 0))).readings[R.correlation]).toBeCloseTo(-1, 3);
    const a = noise(1);
    const b = noise(99);
    const unrelated = stereo((_i, ch) => (ch === 0 ? a() : b()) * 0.3, 5);
    expect(Math.abs(unrelated.readings[R.correlation] as number)).toBeLessThan(0.1);
  });

  it('width: 0 for mono, 0.5 for one channel only, 1 for opposite polarity', () => {
    const t = tone(-12, 440);
    expect(stereo((i) => t(i, 0)).readings[R.widthMid]).toBeLessThan(0.01);
    expect(stereo((i, ch) => (ch === 0 ? t(i, 0) : 0)).readings[R.widthMid]).toBeCloseTo(0.5, 2);
    expect(stereo((i, ch) => (ch === 0 ? t(i, 0) : -t(i, 0))).readings[R.widthMid]).toBeGreaterThan(0.99);
  });

  it('a wide top over a mono bass: width low, mid and high are told apart', () => {
    const v = stereo((i, ch) => {
      const bass = 0.3 * Math.sin((2 * Math.PI * 60 * i) / SR);
      const top = 0.2 * Math.sin((2 * Math.PI * 6000 * i) / SR);
      return bass + (ch === 0 ? top : -top);
    });
    expect(v.readings[R.widthLow]).toBeLessThan(0.05);
    expect(v.readings[R.widthHigh]).toBeGreaterThan(0.95);
    expect(v.readings[R.corrLow]).toBeGreaterThan(0.95);
  });

  it('an out-of-phase bass is caught: low correlation −1, the bass vanishes in mono, the rest does not', () => {
    const v = stereo((i, ch) => {
      const bass = 0.3 * Math.sin((2 * Math.PI * 60 * i) / SR);
      const top = 0.2 * Math.sin((2 * Math.PI * 1000 * i) / SR);
      return (ch === 0 ? bass : -bass) + top;
    });
    expect(v.readings[R.corrLow]).toBeLessThan(-0.95);
    expect(v.readings[R.monoLossLow]).toBeLessThan(-20);
    expect(v.readings[R.levelLow]).toBeGreaterThan(-20);
    // The mix as a whole loses only the bass: well under a half of its power remains... the top is in phase.
    expect(v.readings[R.monoLoss]).toBeLessThan(0);
    expect(v.readings[R.monoLoss]).toBeGreaterThan(-6);
  });

  it('unrelated channels lose 3 dB in mono; a mono signal loses nothing', () => {
    const a = noise(5);
    const b = noise(7);
    const un = stereo((_i, ch) => (ch === 0 ? a() : b()) * 0.3, 5);
    expect(un.readings[R.monoLoss]).toBeGreaterThan(-3.5);
    expect(un.readings[R.monoLoss]).toBeLessThan(-2.5);
    const t = tone(-12, 440);
    expect(stereo((i) => t(i, 0)).readings[R.monoLoss]).toBeCloseTo(0, 2);
  });
});

describe('spectrum and goniometer', () => {
  it('a full-scale sine in both channels reads 1 (0 dBFS) in its bin; in one channel 0.5; and nothing far away', () => {
    const bin = 85;
    const hz = (bin * SR) / SPECTRUM_SIZE;
    const both = made();
    both.v.readings[R.detail] = 1;
    feed(both.k, (i) => Math.sin((2 * Math.PI * hz * i) / SR), 1);
    expect(both.v.spectrum[bin]).toBeGreaterThan(0.97);
    expect(both.v.spectrum[bin]).toBeLessThan(1.03);
    expect(both.v.spectrum[bin + 40]).toBeLessThan(1e-6);
    expect(both.v.readings[R.spectrumSeq]).toBeGreaterThan(5);
    const one = made();
    one.v.readings[R.detail] = 1;
    feed(one.k, (i, ch) => (ch === 0 ? Math.sin((2 * Math.PI * hz * i) / SR) : 0), 1);
    expect(one.v.spectrum[bin]).toBeGreaterThan(0.48);
    expect(one.v.spectrum[bin]).toBeLessThan(0.52);
  });

  it('basic detail leaves the spectrum, the bands and the scope alone (and so costs less)', () => {
    const { k, v } = made();
    feed(k, tone(-12), 1);
    expect(v.readings[R.spectrumSeq]).toBe(0);
    expect(v.readings[R.scopePos]).toBe(0);
    expect(v.spectrum.every((x) => x === 0)).toBe(true);
    expect(v.readings[R.integrated]).toBeLessThan(0);
  });

  it('the goniometer ring holds the newest frames, left and right interleaved', () => {
    const { k, v } = made();
    v.readings[R.detail] = 1;
    const frames = SCOPE_FRAMES + 300;
    feed(k, (i, ch) => (ch === 0 ? 0.5 : -0.25) * (i % 2 === 0 ? 1 : -1), frames / SR);
    expect(Math.abs(v.scope[0] as number)).toBe(0.5);
    expect(Math.abs(v.scope[1] as number)).toBe(0.25);
    expect(v.readings[R.scopePos]).toBe(frames % SCOPE_FRAMES);
  });
});

describe('history and controls', () => {
  it('writes the momentary and short-term loudness every 100 ms while there is sound, and pauses in silence', () => {
    const { k, v } = made();
    let at = feed(k, tone(-20), 5);
    const count = v.readings[R.histCount] as number;
    expect(count).toBeGreaterThan(45);
    expect(count).toBeLessThan(55);
    const last = ((count - 1) % HISTORY_CAPACITY) * 2;
    expect(v.history[last]).toBeCloseTo(-20, 1);
    at = feed(k, () => 0, 60, at);
    // Silence adds a few seconds of points, then stops: a stopped song doesn't scroll the graph away.
    expect((v.readings[R.histCount] as number) - count).toBeLessThan(45);
    v.readings[R.resetSeq] = 1;
    feed(k, tone(-20), 0.2, at);
    expect(v.readings[R.histStart]).toBeGreaterThan(count);
    expect(v.readings[R.histStart]).toBeLessThanOrEqual(v.readings[R.histCount] as number);
  });

  it('ends when closed', () => {
    const { k, v } = made();
    expect(k.closed).toBe(false);
    v.readings[R.closed] = 1;
    expect(k.closed).toBe(true);
  });

  it('copes with a missing input (nothing connected), a mono input and a block longer than 128 frames', () => {
    const { k, v } = made();
    k.process(undefined, undefined, 128);
    k.process(new Float32Array(128).fill(0.1), undefined, 128);
    k.process(new Float32Array(480).fill(0.1), new Float32Array(480).fill(0.1), 480);
    expect(v.readings[R.blocks]).toBe(3);
  });
});

describe('cost', () => {
  it('measuring loudness, peaks and correlation costs under 1.5 % of a core at 48 kHz; the full suite under 4 %', { tags: ['perf'], timeout: 120_000 }, async () => {
    const rows: string[] = [];
    for (const detail of [0, 1]) {
      const { k, v } = made();
      v.readings[R.detail] = detail;
      const l = Float32Array.from({ length: 128 }, (_, i) => 0.3 * Math.sin(i * 0.1));
      const r = Float32Array.from({ length: 128 }, (_, i) => 0.3 * Math.sin(i * 0.13));
      const run = (seconds: number) => {
        for (let f = 0; f < seconds * SR; f += 128) k.process(l, r, 128);
      };
      run(2);
      const measure = () => {
        let best = Infinity;
        for (let t = 0; t < 3; t++) {
          const t0 = cpuNow();
          run(4);
          best = Math.min(best, cpuNow() - t0);
        }
        return best;
      };
      const limit = detail ? 4 : 1.5;
      const ms = await settle(measure, (x) => (x / 4000) * 100 < limit);
      const share = (ms / 4000) * 100;
      rows.push(`${detail ? 'full' : 'basic'}: ${share.toFixed(2)} % of a core`);
      expect(share, rows.at(-1)).toBeLessThan(limit * 2);
    }
    console.log(`Meter suite cost at 48 kHz:\n${rows.join('\n')}`);
  });
});
