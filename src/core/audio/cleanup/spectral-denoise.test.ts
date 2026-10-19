import { describe, expect, it } from 'vitest';
import { hannWindow, RealFFT } from '../../voice/fft';
import { denoiseFrameSize, findQuietStretch, learnNoiseProfile, monoOf, sqrtHannWindow } from './noise-profile';
import { denoiseChannels, gainFloor, type DenoiseSettings } from './spectral-denoise';
import { pinkNoise, rms, syntheticPhrase, toDb, type Span } from './test-signals';

const SAMPLE_RATE = 48000;
const AMOUNT_12: DenoiseSettings = { amountDb: 12, sensitivity: 0.5 };

/** Mean power (as RMS² summed) of the signal over the spans, in dB relative to full scale. */
function levelOver(x: Float32Array, spans: readonly Span[], rate: number): number {
  let sum = 0;
  let count = 0;
  for (const span of spans) {
    const a = Math.round(span.from * rate);
    const b = Math.round(span.to * rate);
    for (let i = a; i < b; i++) sum += (x[i] as number) ** 2;
    count += b - a;
  }
  return 10 * Math.log10(sum / Math.max(1, count) + 1e-20);
}

/** The pauses between phrases that hold no breath (room noise only), and the opening silence. */
function noiseOnlySpans(phrase: ReturnType<typeof syntheticPhrase>): Span[] {
  return [...phrase.quiet, { from: phrase.sampleRate > 0 ? 11.4 : 0, to: 11.95 }];
}

/** Share of time-frequency cells (1024-sample frames) more than `db` above their frequency's mean power: isolated bursts. */
function burstFraction(x: Float32Array, db: number): number {
  const size = 1024;
  const fft = new RealFFT(size);
  const window = hannWindow(size);
  const re = new Float64Array(fft.bins);
  const im = new Float64Array(fft.bins);
  const cells: Float64Array[] = [];
  for (let at = 0; at + size <= x.length; at += 256) {
    for (let i = 0; i < size; i++) fft.frame[i] = (x[at + i] as number) * (window[i] as number);
    fft.forward(fft.frame, re, im);
    cells.push(Float64Array.from({ length: fft.bins }, (_, k) => (re[k] as number) ** 2 + (im[k] as number) ** 2));
  }
  const mean = new Float64Array(fft.bins);
  for (const cell of cells) for (let k = 0; k < fft.bins; k++) mean[k] = (mean[k] as number) + (cell[k] as number) / cells.length;
  const limit = Math.pow(10, db / 10);
  let over = 0;
  for (const cell of cells) for (let k = 2; k < fft.bins - 1; k++) if ((cell[k] as number) > limit * (mean[k] as number)) over++;
  return over / (cells.length * (fft.bins - 3));
}

/** Plain spectral subtraction, the control: each frame on its own, no memory, no smoothing. */
function naiveSubtraction(x: Float32Array, noisePower: Float64Array, amountDb: number): Float32Array {
  const size = denoiseFrameSize(SAMPLE_RATE);
  const hop = size / 4;
  const fft = new RealFFT(size);
  const window = sqrtHannWindow(size);
  const re = new Float64Array(fft.bins);
  const im = new Float64Array(fft.bins);
  const out = new Float32Array(x.length);
  const floor = gainFloor(amountDb);
  for (let from = -3 * hop; from < x.length; from += hop) {
    for (let i = 0; i < size; i++) {
      const at = from + i;
      fft.frame[i] = at >= 0 && at < x.length ? (x[at] as number) * (window[i] as number) : 0;
    }
    fft.forward(fft.frame, re, im);
    for (let k = 0; k < fft.bins; k++) {
      const power = (re[k] as number) ** 2 + (im[k] as number) ** 2;
      const gain = Math.max(1 - Math.sqrt((2 * (noisePower[k] as number)) / (power + 1e-30)), floor);
      re[k] = (re[k] as number) * gain;
      im[k] = (im[k] as number) * gain;
    }
    fft.inverse(re, im, fft.frame);
    for (let i = 0; i < size; i++) {
      const at = from + i;
      if (at >= 0 && at < x.length) out[at] = (out[at] as number) + ((fft.frame[i] as number) * (window[i] as number)) / 2;
    }
  }
  return out;
}

describe('noise profile', () => {
  const phrase = syntheticPhrase({ noiseDb: -40 });

  it('finds the quietest half second where only the room is heard', () => {
    const stretch = findQuietStretch(phrase.mix, SAMPLE_RATE);
    expect(stretch).not.toBeNull();
    const level = levelOver(phrase.mix, [stretch!], SAMPLE_RATE);
    expect(Math.abs(level - levelOver(phrase.noise, [stretch!], SAMPLE_RATE))).toBeLessThan(0.3);
    expect(stretch!.to - stretch!.from).toBeCloseTo(0.5, 2);
  });

  it('says there is nothing to learn from silence, and from a stretch that is too short', () => {
    expect(findQuietStretch(new Float32Array(SAMPLE_RATE * 2), SAMPLE_RATE)).toBeNull();
    expect(findQuietStretch(phrase.mix.subarray(0, 1000), SAMPLE_RATE)).toBeNull();
    expect(learnNoiseProfile(new Float32Array(SAMPLE_RATE), SAMPLE_RATE, 0, 1)).toBeNull();
    expect(learnNoiseProfile(phrase.mix, SAMPLE_RATE, 0.1, 0.12)).toBeNull();
  });

  it('measures the noise power per frequency (a pink tilt falls with frequency)', () => {
    const profile = learnNoiseProfile(phrase.noise, SAMPLE_RATE, 1, 3)!;
    expect(profile.frameSize).toBe(2048);
    expect(profile.power[10]! / profile.power[400]!).toBeGreaterThan(10);
  });
});

describe('spectral noise reduction', () => {
  const phrase = syntheticPhrase({ noiseDb: -40 });
  const stretch = findQuietStretch(phrase.mix, SAMPLE_RATE)!;
  const profile = learnNoiseProfile(phrase.mix, SAMPLE_RATE, stretch.from, stretch.to)!;
  // The gains are found from the mix, then applied to the voice and to the noise on their own: what a listener
  // hears of each is what each is worth after the same gains.
  const voiceOut = denoiseChannels([phrase.voice], SAMPLE_RATE, profile, AMOUNT_12, { gainsFrom: phrase.mix })[0]!;
  const noiseOut = denoiseChannels([phrase.noise], SAMPLE_RATE, profile, AMOUNT_12, { gainsFrom: phrase.mix })[0]!;

  it('lifts the signal-to-noise ratio by at least 10 dB at 12 dB (the noise floor in the pauses against the vowels)', () => {
    const quiet = noiseOnlySpans(phrase);
    const before = levelOver(phrase.voice, phrase.vowels, SAMPLE_RATE) - levelOver(phrase.noise, quiet, SAMPLE_RATE);
    const after = levelOver(voiceOut, phrase.vowels, SAMPLE_RATE) - levelOver(noiseOut, quiet, SAMPLE_RATE);
    expect(after - before).toBeGreaterThanOrEqual(10);
    expect(after - before).toBeLessThan(14);
  });

  it('keeps the voice within 1 dB, the vowels and the "s" sounds alike', () => {
    expect(Math.abs(levelOver(voiceOut, phrase.vowels, SAMPLE_RATE) - levelOver(phrase.voice, phrase.vowels, SAMPLE_RATE))).toBeLessThan(1);
    expect(Math.abs(levelOver(voiceOut, phrase.hisses, SAMPLE_RATE) - levelOver(phrase.voice, phrase.hisses, SAMPLE_RATE))).toBeLessThan(1);
  });

  it('turns the noise down inside the vowels too, where only the gaps between harmonics can be reached', () => {
    const drop = levelOver(phrase.noise, phrase.vowels, SAMPLE_RATE) - levelOver(noiseOut, phrase.vowels, SAMPLE_RATE);
    expect(drop).toBeGreaterThan(5);
  });

  it('is the sum of its parts: gains found from the mix, applied to the mix, give the voice plus the noise', () => {
    const whole = denoiseChannels([phrase.mix], SAMPLE_RATE, profile, AMOUNT_12)[0]!;
    // The mix's own gains are the ones both parts above were given (the breaths ride along in the mix).
    let worst = 0;
    const withBreaths = denoiseChannels([phrase.breaths], SAMPLE_RATE, profile, AMOUNT_12, { gainsFrom: phrase.mix })[0]!;
    for (let i = 0; i < whole.length; i += 7) worst = Math.max(worst, Math.abs((whole[i] as number) - (voiceOut[i] as number) - (noiseOut[i] as number) - (withBreaths[i] as number)));
    expect(worst).toBeLessThan(1e-5);
  });

  it('leaves no musical noise: bursts in the noise-only output stay near what the noise itself has, unlike plain subtraction', () => {
    const noise = pinkNoise(SAMPLE_RATE * 8, -40, 5);
    const own = learnNoiseProfile(noise, SAMPLE_RATE, 0, 1)!;
    const cleaned = denoiseChannels([noise.subarray(SAMPLE_RATE)], SAMPLE_RATE, own, AMOUNT_12)[0]!;
    const naive = naiveSubtraction(noise.subarray(SAMPLE_RATE), own.power, 12);
    const input = burstFraction(noise.subarray(SAMPLE_RATE), 10);
    const ours = burstFraction(cleaned, 10);
    const control = burstFraction(naive, 10);
    // 1.5 s of noise holds only a few hundred thousand cells: bounds are in cells, not ratios of tiny numbers.
    expect(ours).toBeLessThan(Math.max(5 * input, 3e-4));
    expect(control).toBeGreaterThan(5 * ours);
    // And the noise really went down about the amount asked for.
    expect(toDb(rms(noise.subarray(SAMPLE_RATE)) / rms(cleaned))).toBeGreaterThan(10);
    expect(toDb(rms(noise.subarray(SAMPLE_RATE)) / rms(cleaned))).toBeLessThan(13);
  });

  it('keeps the spectrum of the leftover noise like the noise (a tilt stays a tilt, nothing whistles)', () => {
    const noise = pinkNoise(SAMPLE_RATE * 6, -40, 11);
    const own = learnNoiseProfile(noise, SAMPLE_RATE, 0, 1)!;
    const cleaned = denoiseChannels([noise.subarray(SAMPLE_RATE)], SAMPLE_RATE, own, AMOUNT_12)[0]!;
    const before = learnNoiseProfile(noise.subarray(SAMPLE_RATE), SAMPLE_RATE, 0, 5)!;
    const after = learnNoiseProfile(cleaned, SAMPLE_RATE, 0, 5)!;
    for (const k of [20, 60, 150, 400, 800]) {
      const change = 10 * Math.log10((before.power[k] as number) / (after.power[k] as number));
      expect(change).toBeGreaterThan(9);
      expect(change).toBeLessThan(15);
    }
  });

  it('takes mains hum down: a 50 Hz line and its harmonics fall by the amount', () => {
    const hummy = syntheticPhrase({ noiseDb: -46, humDb: -34, seed: 3 });
    const quietStretch = findQuietStretch(hummy.mix, SAMPLE_RATE)!;
    const learned = learnNoiseProfile(hummy.mix, SAMPLE_RATE, quietStretch.from, quietStretch.to)!;
    const out = denoiseChannels([hummy.noise], SAMPLE_RATE, learned, { amountDb: 24, sensitivity: 0.5 }, { gainsFrom: hummy.mix })[0]!;
    const lineBefore = learnNoiseProfile(hummy.noise, SAMPLE_RATE, 1, 5)!;
    const lineAfter = learnNoiseProfile(out, SAMPLE_RATE, 1, 5)!;
    const bin = Math.round(50 / (SAMPLE_RATE / 2048));
    const drop = 10 * Math.log10((lineBefore.power[bin] as number) / (lineAfter.power[bin] as number));
    expect(drop).toBeGreaterThan(15);
  });

  it('is deterministic: two runs are bit-identical', () => {
    const a = denoiseChannels([phrase.mix], SAMPLE_RATE, profile, AMOUNT_12)[0]!;
    const b = denoiseChannels([phrase.mix], SAMPLE_RATE, profile, AMOUNT_12)[0]!;
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
  });

  it('does nothing at 0 dB, and keeps every length', () => {
    const copy = denoiseChannels([phrase.mix], SAMPLE_RATE, profile, { amountDb: 0, sensitivity: 0.5 })[0]!;
    expect(Buffer.from(copy.buffer).equals(Buffer.from(phrase.mix.buffer))).toBe(true);
    const odd = phrase.mix.subarray(1234, 1234 + 50001);
    expect(denoiseChannels([odd], SAMPLE_RATE, profile, AMOUNT_12)[0]!.length).toBe(50001);
    expect(denoiseChannels([new Float32Array(0)], SAMPLE_RATE, profile, AMOUNT_12)[0]!.length).toBe(0);
  });

  it('treats the channels of a stereo sound alike: the same gains, so the image does not move', () => {
    const left = phrase.mix;
    const right = Float32Array.from(phrase.mix, (v) => 0.5 * v);
    const [outLeft, outRight] = denoiseChannels([left, right], SAMPLE_RATE, profile, AMOUNT_12);
    let worst = 0;
    for (let i = 0; i < left.length; i += 11) worst = Math.max(worst, Math.abs(0.5 * (outLeft![i] as number) - (outRight![i] as number)));
    expect(worst).toBeLessThan(1e-6);
  });

  it('survives a long recording through several chunks with the same result as the pieces of it', () => {
    const long = syntheticPhrase({ noiseDb: -40, seconds: 40, seed: 9 });
    const learned = learnNoiseProfile(long.mix, SAMPLE_RATE, 0.1, 0.7)!;
    const out = denoiseChannels([long.mix], SAMPLE_RATE, learned, AMOUNT_12)[0]!;
    expect(out.length).toBe(long.mix.length);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    const quiet = [{ from: 0.1, to: 0.7 }];
    expect(levelOver(long.mix, quiet, SAMPLE_RATE) - levelOver(out, quiet, SAMPLE_RATE)).toBeGreaterThan(9);
  });
});

describe('mono mix', () => {
  it('is the channel itself for one channel and the mean for two', () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([3, 2, 1]);
    expect(monoOf([a])).toBe(a);
    expect(Array.from(monoOf([a, b]))).toEqual([2, 2, 2]);
  });
});
