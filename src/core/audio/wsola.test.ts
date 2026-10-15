import { describe, expect, it } from 'vitest';
import { autocorrelationPitch, clickTrain, harmonicTone, onsetFrames, rmsOf, sine } from '../../../test/helpers/audio';
import { detectOnsets, timeStretch } from './wsola';

const SR = 48000;

describe('WSOLA time-stretch', () => {
  it('makes the audio exactly scale × as long', () => {
    const x = harmonicTone(220, 1, SR);
    for (const scale of [0.5, 0.8, 1, 1.25, 2]) {
      const [y] = timeStretch([x], scale, { sampleRate: SR });
      expect(y!.length).toBe(Math.round(x.length * scale));
    }
  });

  it('keeps the pitch while changing the duration', () => {
    const x = harmonicTone(220, 1.5, SR);
    expect(autocorrelationPitch(x, SR, 0, SR)).toBeCloseTo(220, 0);
    for (const scale of [0.7, 1.5, 2]) {
      const [y] = timeStretch([x], scale, { sampleRate: SR });
      const mid = Math.floor(y!.length / 2);
      const hz = autocorrelationPitch(y!, SR, mid - SR / 4, mid + SR / 4);
      expect(Math.abs(hz / 220 - 1)).toBeLessThan(0.005);
    }
  });

  it('moves every hit to its stretched time', () => {
    const x = clickTrain(0.25, 2, SR, 0.1);
    for (const scale of [0.75, 1.6]) {
      const [y] = timeStretch([x], scale, { sampleRate: SR });
      const hits = onsetFrames(y!, SR, 0.2, 0.08);
      const want = onsetFrames(x, SR, 0.2, 0.08).map((f) => f * scale);
      expect(hits.length).toBe(want.length);
      // Within the search tolerance plus half a frame.
      hits.forEach((h, i) => expect(Math.abs(h - want[i]!) / SR).toBeLessThan(0.035));
    }
  });

  it('keeps the level and the stereo image', () => {
    const l = sine(330, 1, SR, 0.5);
    const r = sine(330, 1, SR, 0.5);
    const [a, b] = timeStretch([l, r], 1.3, { sampleRate: SR });
    expect(a).toEqual(b);
    const level = rmsOf(a!, SR / 4, a!.length - SR / 4) / rmsOf(l);
    expect(Math.abs(20 * Math.log10(level))).toBeLessThan(1);
  });

  /** 5 ms clicks every 0.5 s (from 0.25 s) over a quiet 110 Hz tone, and where each one starts. */
  const clickBed = (seconds: number) => {
    const x = sine(110, seconds, SR, 0.05);
    const at: number[] = [];
    for (let t = 0.25; t < seconds - 0.2; t += 0.5) {
      const i = Math.round(t * SR);
      for (let k = 0; k < 0.005 * SR; k++) x[i + k] = (x[i + k] as number) + Math.exp(-k / (0.001 * SR)) * (k % 2 ? -1 : 1);
      at.push(i);
    }
    return { x, at };
  };

  /** Clicks heard: where |y| first goes over 0.3 after 3 ms below it, and the loudest sample of each. */
  const peaks = (y: Float32Array) => {
    const out: Array<{ at: number; level: number }> = [];
    let lastLoud = -Infinity;
    for (let i = 0; i < y.length; i++) {
      const a = Math.abs(y[i] as number);
      if (a < 0.3) continue;
      if (i - lastLoud > SR * 0.003) out.push({ at: i, level: a });
      else out[out.length - 1]!.level = Math.max(out[out.length - 1]!.level, a);
      lastLoud = i;
    }
    return out;
  };

  it('finds attacks where the energy jumps', () => {
    const { x, at } = clickBed(4);
    const found = detectOnsets(x, SR).map((o) => o.at);
    expect(found).toEqual(at);
  });

  it('keeps every hit whole and on its stretched time (no doubled, weakened or skipped clicks)', () => {
    const { x, at } = clickBed(10);
    for (const scale of [0.8, 0.94, 1.06, 1.25, 1.5]) {
      const [y] = timeStretch([x], scale, { sampleRate: SR });
      const got = peaks(y!);
      expect(got.length).toBe(at.length);
      got.forEach((p, i) => {
        expect(p.level).toBeGreaterThan(0.95);
        // The search may shift the run into an attack by up to 2 ms.
        expect(Math.abs(p.at - at[i]! * scale) / SR).toBeLessThan(0.0025);
      });
    }
  });

  it('plain WSOLA (no transient handling) doubles and moves the same clicks: the measurement before', () => {
    const { x, at } = clickBed(10);
    const [slow] = timeStretch([x], 1.5, { sampleRate: SR, transients: false });
    expect(peaks(slow!).length).toBeGreaterThan(at.length);
    const [fast] = timeStretch([x], 0.8, { sampleRate: SR, transients: false });
    const f = peaks(fast!);
    const worst = Math.max(...f.map((p) => Math.min(...at.map((a) => Math.abs(p.at - a * 0.8)))));
    expect(worst / SR).toBeGreaterThan(0.004);
  });
});

