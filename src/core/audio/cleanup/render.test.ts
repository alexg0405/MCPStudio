import { describe, expect, it } from 'vitest';
import type { VocalCleanup } from '../../model/types';
import { analyzeCleanup, removedSound, renderCleanup } from './render';
import { rms, syntheticPhrase, toDb } from './test-signals';

const SAMPLE_RATE = 48000;
const phrase = syntheticPhrase({ seconds: 20, noiseDb: -48, seed: 5 });

/** Adds a click to a copy of the mix at each time (seconds). */
function withClicks(times: readonly number[]): Float32Array {
  const x = Float32Array.from(phrase.mix);
  for (const t of times) {
    const start = Math.round(t * SAMPLE_RATE);
    for (let i = 0; i < 0.003 * SAMPLE_RATE; i++) {
      const s = i / SAMPLE_RATE;
      x[start + i] = (x[start + i] as number) + 0.25 * Math.exp(-s / 0.0004) * Math.sin(2 * Math.PI * 3500 * s);
    }
  }
  return x;
}

const everything: VocalCleanup = {
  noise: { amountDb: 12, sensitivity: 0.5 },
  breaths: { reduceDb: 12, sensitivity: 0.5 },
  clicks: { sensitivity: 0.5 },
};

describe('vocal cleanup render', () => {
  it('runs the whole chain: clicks repaired, noise down, breaths down, singing kept, and says what it found', () => {
    const clickTimes = [0.5, 1.1];
    const input = withClicks(clickTimes);
    const { channels, findings } = renderCleanup({ channels: [input], sampleRate: SAMPLE_RATE, settings: everything });
    const out = channels[0]!;
    expect(out.length).toBe(input.length);
    expect(findings.clickCount).toBeGreaterThanOrEqual(2);
    // The click at 0.5 s (in the room noise) has gone: nothing near its size is left there.
    const peakAt = (x: Float32Array, t: number) => Math.max(...Array.from(x.subarray(Math.round(t * SAMPLE_RATE), Math.round((t + 0.004) * SAMPLE_RATE)), Math.abs));
    expect(peakAt(input, 0.5)).toBeGreaterThan(0.1);
    expect(peakAt(out, 0.5)).toBeLessThan(0.02);
    // Noise: the quiet room is well down. Breaths: found, and down. Singing: kept within 1.5 dB.
    expect(toDb(rms(input, Math.round(0.1 * SAMPLE_RATE), Math.round(0.4 * SAMPLE_RATE)) / rms(out, Math.round(0.1 * SAMPLE_RATE), Math.round(0.4 * SAMPLE_RATE)))).toBeGreaterThan(9);
    expect(findings.breaths!.length).toBeGreaterThanOrEqual(5);
    const vowel = phrase.vowels[3]!;
    const a = Math.round(vowel.from * SAMPLE_RATE);
    const b = Math.round(vowel.to * SAMPLE_RATE);
    expect(Math.abs(toDb(rms(out, a, b) / rms(input, a, b)))).toBeLessThan(1.5);
    expect(findings.noise).toBeDefined();
    expect(findings.noiseProblem).toBeUndefined();
  });

  it('is deterministic: two renders are bit-identical, stereo too, and the input is not touched', () => {
    const right = Float32Array.from(phrase.mix, (v) => 0.6 * v);
    const left = Float32Array.from(phrase.mix);
    const before = Float32Array.from(left);
    const one = renderCleanup({ channels: [left, right], sampleRate: SAMPLE_RATE, settings: everything }).channels;
    const two = renderCleanup({ channels: [left, right], sampleRate: SAMPLE_RATE, settings: everything }).channels;
    for (let c = 0; c < 2; c++) expect(Buffer.from(one[c]!.buffer).equals(Buffer.from(two[c]!.buffer))).toBe(true);
    expect(Buffer.from(left.buffer).equals(Buffer.from(before.buffer))).toBe(true);
  });

  it('uses the stretch and the breaths it is given instead of looking again, and switched-off breaths stay', () => {
    const settings: VocalCleanup = {
      noise: { amountDb: 12, sensitivity: 0.5, from: 0.1, to: 0.7 },
      breaths: { reduceDb: 30, sensitivity: 0.5, spans: [{ from: 2.8, to: 3.05 }, { from: 5.45, to: 5.7, off: true }] },
    };
    const { channels, findings } = renderCleanup({ channels: [phrase.mix], sampleRate: SAMPLE_RATE, settings });
    expect(findings.noise).toEqual({ from: 0.1, to: 0.7 });
    expect(findings.breaths).toEqual(settings.breaths!.spans);
    const level = (x: Float32Array, from: number, to: number) => rms(x, Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE));
    const out = channels[0]!;
    const noiseOnly = renderCleanup({ channels: [phrase.mix], sampleRate: SAMPLE_RATE, settings: { noise: settings.noise! } }).channels[0]!;
    // The marker that is off matches a noise-only render there; the other one is far below it.
    expect(level(out, 5.5, 5.65)).toBeCloseTo(level(noiseOnly, 5.5, 5.65), 5);
    expect(level(out, 2.85, 3.0)).toBeLessThan(level(noiseOnly, 2.85, 3.0) / 10);
  });

  it('does nothing when no section is on', () => {
    const { channels } = renderCleanup({ channels: [phrase.mix], sampleRate: SAMPLE_RATE, settings: {} });
    expect(Buffer.from(channels[0]!.buffer).equals(Buffer.from(phrase.mix.buffer))).toBe(true);
  });

  it('says why noise reduction could not run when the sound has no quiet stretch to learn from', () => {
    const settings: VocalCleanup = { noise: { amountDb: 12, sensitivity: 0.5 } };
    const loud = Float32Array.from({ length: SAMPLE_RATE * 2 }, (_, i) => 0.3 * Math.sin(i * 0.05));
    const silent = new Float32Array(SAMPLE_RATE * 2);
    expect(analyzeCleanup([silent], SAMPLE_RATE, settings).noiseProblem).toMatch(/quiet stretch/);
    expect(analyzeCleanup([loud], SAMPLE_RATE, settings).noise).toBeDefined();
    const chosenSilent: VocalCleanup = { noise: { amountDb: 12, sensitivity: 0.5, from: 0.2, to: 1 } };
    const result = renderCleanup({ channels: [silent], sampleRate: SAMPLE_RATE, settings: chosenSilent });
    expect(result.findings.noiseProblem).toMatch(/silent or too short/);
    expect(rms(result.channels[0]!)).toBe(0);
  });

  it('the removed sound is exactly the input minus the output, and adds back to it', () => {
    const { channels } = renderCleanup({ channels: [phrase.mix], sampleRate: SAMPLE_RATE, settings: { noise: { amountDb: 12, sensitivity: 0.5 } } });
    const removed = removedSound([phrase.mix], channels)[0]!;
    for (let i = 0; i < removed.length; i += 997) expect(removed[i]! + channels[0]![i]!).toBeCloseTo(phrase.mix[i]!, 6);
    // What was removed in the quiet is the noise: 12 dB down leaves a quarter of its amplitude, so three quarters (−2.5 dB) is removed.
    const quiet = [Math.round(0.1 * SAMPLE_RATE), Math.round(0.7 * SAMPLE_RATE)] as const;
    expect(toDb(rms(removed, ...quiet) / rms(phrase.mix, ...quiet))).toBeGreaterThan(-3);
  });

  it('reports progress up to 1', () => {
    const seen: number[] = [];
    renderCleanup({ channels: [phrase.mix], sampleRate: SAMPLE_RATE, settings: everything, onProgress: (f) => seen.push(f) });
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((f, i) => i === 0 || f >= seen[i - 1]!)).toBe(true);
  });
});
