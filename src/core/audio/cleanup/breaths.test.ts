import { describe, expect, it } from 'vitest';
import { BREATH_FADE_SECONDS, BREATH_REMOVE_DB, detectBreaths, lowerBreaths } from './breaths';
import { rms, syntheticPhrase, toDb, type Span } from './test-signals';

const SAMPLE_RATE = 48000;

const overlap = (a: Span, b: Span) => Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));

/** How many of the true breaths have a found span over at least half of them. */
function foundCount(found: readonly Span[], truth: readonly Span[]): number {
  return truth.filter((t) => found.some((f) => overlap(f, t) >= 0.5 * (t.to - t.from))).length;
}

/** Found spans that touch a syllable (a vowel or an "s") by more than 20 ms. */
function onSyllables(found: readonly Span[], phrase: ReturnType<typeof syntheticPhrase>): Span[] {
  return found.filter((f) => [...phrase.vowels, ...phrase.hisses].some((s) => overlap(f, s) > 0.02));
}

describe('breath detection', () => {
  // 40 s: fourteen breaths between phrases, with an "s" (10 dB under the vowels) before each phrase.
  it.each([
    { noiseDb: -50, breathDb: -16 },
    { noiseDb: -46, breathDb: -16 },
    { noiseDb: -50, breathDb: -22 },
  ])('finds at least 90 % of the breaths and marks no syllable (noise $noiseDb dBFS, breath $breathDb dB under the vowels)', ({ noiseDb, breathDb }) => {
    const phrase = syntheticPhrase({ seconds: 40, noiseDb, breathDb, seed: 5 });
    const found = detectBreaths(phrase.mix, SAMPLE_RATE, 0.5);
    expect(phrase.breathSpans.length).toBeGreaterThanOrEqual(12);
    expect(foundCount(found, phrase.breathSpans) / phrase.breathSpans.length).toBeGreaterThanOrEqual(0.9);
    expect(onSyllables(found, phrase)).toEqual([]);
    // No extra marks either: every mark is over a real breath.
    expect(found.every((f) => phrase.breathSpans.some((t) => overlap(f, t) > 0))).toBe(true);
  });

  it('does not mark loud "s" sounds even when they are as long as a breath is allowed to be short', () => {
    const phrase = syntheticPhrase({ seconds: 40, hissDb: -3, seed: 8 });
    expect(onSyllables(detectBreaths(phrase.mix, SAMPLE_RATE, 1), phrase)).toEqual([]);
  });

  it('finds nothing in room noise alone, in singing alone, and in a clip too short to compare', () => {
    const phrase = syntheticPhrase({ seconds: 20, seed: 6 });
    expect(detectBreaths(phrase.noise, SAMPLE_RATE)).toEqual([]);
    expect(detectBreaths(phrase.voice, SAMPLE_RATE)).toEqual([]);
    expect(detectBreaths(new Float32Array(100), SAMPLE_RATE)).toEqual([]);
  });

  it('finds more of the quiet ones when the sensitivity is raised', () => {
    const phrase = syntheticPhrase({ seconds: 40, breathDb: -22, seed: 2 });
    const strict = detectBreaths(phrase.mix, SAMPLE_RATE, 0.1);
    const eager = detectBreaths(phrase.mix, SAMPLE_RATE, 0.9);
    expect(eager.length).toBeGreaterThanOrEqual(strict.length);
  });

  it('is deterministic', () => {
    const phrase = syntheticPhrase({ seconds: 15, seed: 4 });
    expect(detectBreaths(phrase.mix, SAMPLE_RATE)).toEqual(detectBreaths(phrase.mix, SAMPLE_RATE));
  });
});

describe('lowering breaths', () => {
  const phrase = syntheticPhrase({ seconds: 20, seed: 5 });
  const found = detectBreaths(phrase.mix, SAMPLE_RATE);

  const levelIn = (x: Float32Array, spans: readonly Span[]) => {
    let sum = 0;
    let count = 0;
    for (const s of spans) {
      const a = Math.round(s.from * SAMPLE_RATE);
      const b = Math.round(s.to * SAMPLE_RATE);
      for (let i = a; i < b; i++) sum += (x[i] as number) ** 2;
      count += b - a;
    }
    return 10 * Math.log10(sum / count);
  };

  it('turns the chosen breaths down by about the amount, in the middle of each, and leaves the singing bit for bit', () => {
    const out = Float32Array.from(phrase.mix);
    lowerBreaths([out], SAMPLE_RATE, found, 12);
    const inner = found.map((f) => ({ from: f.from + 0.05, to: f.to - 0.05 }));
    expect(levelIn(phrase.mix, inner) - levelIn(out, inner)).toBeGreaterThan(11.5);
    expect(levelIn(phrase.mix, inner) - levelIn(out, inner)).toBeLessThan(12.5);
    for (const v of [...phrase.vowels, ...phrase.hisses]) {
      for (let i = Math.round(v.from * SAMPLE_RATE); i < Math.round(v.to * SAMPLE_RATE); i += 13) expect(out[i]).toBe(phrase.mix[i]);
    }
  });

  it('removes a breath completely at the remove setting, and does nothing at 0', () => {
    const out = Float32Array.from(phrase.mix);
    lowerBreaths([out], SAMPLE_RATE, found, BREATH_REMOVE_DB);
    const middle = found[0]!;
    expect(rms(out, Math.round((middle.from + 0.05) * SAMPLE_RATE), Math.round((middle.to - 0.05) * SAMPLE_RATE))).toBe(0);
    const same = Float32Array.from(phrase.mix);
    lowerBreaths([same], SAMPLE_RATE, found, 0);
    expect(Buffer.from(same.buffer).equals(Buffer.from(phrase.mix.buffer))).toBe(true);
  });

  it('fades in and out so nothing clicks: no sample step beyond the breath’s own, even when removing it', () => {
    const breaths = Float32Array.from(phrase.breaths);
    lowerBreaths([breaths], SAMPLE_RATE, phrase.breathSpans, BREATH_REMOVE_DB);
    let step = 0;
    let ownStep = 0;
    for (let i = 1; i < breaths.length; i++) {
      step = Math.max(step, Math.abs((breaths[i] as number) - (breaths[i - 1] as number)));
      ownStep = Math.max(ownStep, Math.abs((phrase.breaths[i] as number) - (phrase.breaths[i - 1] as number)));
    }
    expect(step).toBeLessThan(1.5 * ownStep);
    expect(BREATH_FADE_SECONDS).toBeGreaterThanOrEqual(0.01);
  });

  it('leaves a marker the musician switched off alone', () => {
    const spans = found.map((f, i) => (i === 0 ? { ...f, off: true as const } : f));
    const out = Float32Array.from(phrase.mix);
    lowerBreaths([out], SAMPLE_RATE, spans, 20);
    const first = found[0]!;
    const a = Math.round(first.from * SAMPLE_RATE);
    expect(out[a + 4000]).toBe(phrase.mix[a + 4000]);
    const second = found[1]!;
    expect(toDb(rms(out, Math.round(second.from * SAMPLE_RATE), Math.round(second.to * SAMPLE_RATE)) / rms(phrase.mix, Math.round(second.from * SAMPLE_RATE), Math.round(second.to * SAMPLE_RATE)))).toBeLessThan(-12);
  });

  it('works on every channel', () => {
    const left = Float32Array.from(phrase.mix);
    const right = Float32Array.from(phrase.mix);
    lowerBreaths([left, right], SAMPLE_RATE, found, 12);
    expect(Buffer.from(left.buffer).equals(Buffer.from(right.buffer))).toBe(true);
  });
});
