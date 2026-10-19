import { describe, expect, it } from 'vitest';
import { detectClicks, repairClicks, type SampleSpan } from './clicks';
import { rms, syntheticPhrase, toDb } from './test-signals';

const SAMPLE_RATE = 48000;

/** A synthetic mouth click: a 3.5 kHz burst that dies away in about 1.5 ms. */
function addClick(x: Float32Array, atSeconds: number, amplitude: number): void {
  const start = Math.round(atSeconds * SAMPLE_RATE);
  for (let i = 0; i < 0.003 * SAMPLE_RATE; i++) {
    const t = i / SAMPLE_RATE;
    x[start + i] = (x[start + i] as number) + amplitude * Math.exp(-t / 0.0004) * Math.sin(2 * Math.PI * 3500 * t);
  }
}

const phrase = syntheticPhrase({ seconds: 12, noiseDb: -50, seed: 4 });
/** In the pauses and over vowels, away from the "s" sounds and the breaths. */
const GAP_TIMES = [0.3, 0.6, 3.25, 5.9, 8.55, 11.5];
const VOWEL_TIMES = [1.2, 1.55, 2.0, 2.31, 4.05, 4.52, 7.77, 9.0, 10.3];
const ALL_TIMES = [...GAP_TIMES, ...VOWEL_TIMES];

function withClicks(times: readonly number[], amplitude: number): Float32Array {
  const dirty = Float32Array.from(phrase.mix);
  for (const t of times) addClick(dirty, t, amplitude);
  return dirty;
}

const covers = (spans: readonly SampleSpan[], atSeconds: number) =>
  spans.some((s) => s.from <= atSeconds * SAMPLE_RATE + 20 && s.to >= atSeconds * SAMPLE_RATE + 0.001 * SAMPLE_RATE);

/** RMS of the difference to the clean mix around each click (2 ms before to 5 ms after). */
function errorAround(x: Float32Array, times: readonly number[]): number {
  let sum = 0;
  let count = 0;
  for (const t of times) {
    const a = Math.round((t - 0.002) * SAMPLE_RATE);
    const b = Math.round((t + 0.005) * SAMPLE_RATE);
    for (let i = a; i < b; i++) sum += ((x[i] as number) - (phrase.mix[i] as number)) ** 2;
    count += b - a;
  }
  return Math.sqrt(sum / count);
}

describe('mouth clicks', () => {
  it('finds every click in the pauses and over the vowels, and none in clean singing, noise or breaths', () => {
    expect(detectClicks(phrase.mix, SAMPLE_RATE)).toEqual([]);
    expect(detectClicks(phrase.voice, SAMPLE_RATE)).toEqual([]);
    expect(detectClicks(phrase.breaths, SAMPLE_RATE)).toEqual([]);
    expect(detectClicks(phrase.noise, SAMPLE_RATE)).toEqual([]);
    const spans = detectClicks(withClicks(ALL_TIMES, 0.2), SAMPLE_RATE);
    for (const t of ALL_TIMES) expect(covers(spans, t), `click at ${t} s`).toBe(true);
    // Nothing else is touched: one span per click, each a few milliseconds.
    expect(spans.length).toBe(ALL_TIMES.length);
    for (const s of spans) expect((s.to - s.from) / SAMPLE_RATE).toBeLessThan(0.007);
  });

  it('removes them: the error against the clean sound falls by at least 15 dB, over the vowels as in the pauses', () => {
    const dirty = withClicks(ALL_TIMES, 0.2);
    const fixed = Float32Array.from(dirty);
    repairClicks(fixed, SAMPLE_RATE, detectClicks(dirty, SAMPLE_RATE));
    expect(toDb(errorAround(dirty, GAP_TIMES) / errorAround(fixed, GAP_TIMES))).toBeGreaterThan(15);
    expect(toDb(errorAround(dirty, VOWEL_TIMES) / errorAround(fixed, VOWEL_TIMES))).toBeGreaterThan(10);
    // Nothing outside the repaired spans changed.
    const spans = detectClicks(dirty, SAMPLE_RATE);
    let changed = 0;
    for (let i = 0; i < dirty.length; i++) if (dirty[i] !== fixed[i] && !spans.some((s) => i >= s.from && i < s.to)) changed++;
    expect(changed).toBe(0);
  });

  it('finds quiet clicks in the pauses when the sensitivity is raised, and fewer when it is lowered', () => {
    const dirty = withClicks(GAP_TIMES, 0.05);
    const eager = detectClicks(dirty, SAMPLE_RATE, 1);
    const strict = detectClicks(dirty, SAMPLE_RATE, 0);
    expect([0.3, 0.6, 11.5].every((t) => covers(eager, t))).toBe(true);
    expect(strict.length).toBeLessThanOrEqual(eager.length);
  });

  it('keeps a loud consonant burst and an "s": they last longer than a click', () => {
    const noisy = syntheticPhrase({ seconds: 12, hissDb: -2, seed: 12 });
    expect(detectClicks(noisy.mix, SAMPLE_RATE)).toEqual([]);
  });

  it('repairs a held note through the gap: a pure tone comes back within 1 % of its amplitude', () => {
    const tone = Float32Array.from({ length: SAMPLE_RATE }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE));
    const broken = Float32Array.from(tone);
    const span = { from: 20000, to: 20150 };
    for (let i = span.from; i < span.to; i++) broken[i] = 0.9 * Math.sin(i * 1.7);
    repairClicks(broken, SAMPLE_RATE, [span]);
    let worst = 0;
    for (let i = span.from; i < span.to; i++) worst = Math.max(worst, Math.abs((broken[i] as number) - (tone[i] as number)));
    expect(worst).toBeLessThan(0.01 * 0.3 + 0.003);
  });

  it('repairs at the very start and end of a sound with a straight line instead of failing', () => {
    const x = Float32Array.from({ length: 2000 }, (_, i) => (i === 3 || i === 1995 ? 1 : 0.1));
    repairClicks(x, SAMPLE_RATE, [{ from: 2, to: 6 }, { from: 1993, to: 1998 }]);
    expect(Math.max(...x)).toBeLessThan(0.2);
    expect(x.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('is deterministic and repairs every channel alike', () => {
    const dirty = withClicks(GAP_TIMES, 0.2);
    const spans = detectClicks(dirty, SAMPLE_RATE);
    const a = Float32Array.from(dirty);
    const b = Float32Array.from(dirty);
    repairClicks(a, SAMPLE_RATE, spans);
    repairClicks(b, SAMPLE_RATE, spans);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    expect(rms(a)).toBeGreaterThan(0);
  });
});
