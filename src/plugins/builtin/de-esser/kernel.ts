import { at, dbToGain, EffectKernel, EnvelopeFollower, Readings, Svf, type ParamBlock } from '@agstudio/sdk/worklet';
import type { deEsserParams } from './params';

type P = typeof deEsserParams;

/** 20 / ln(10): dB = DB_PER_NEPER · ln(gain). */
const DB_PER_NEPER = 8.685889638065035;
/** ln(10) / 20: gain = exp(NEPER_PER_DB · dB). */
const NEPER_PER_DB = 0.11512925464970229;
/** Soft knee around the threshold, dB. */
const KNEE = 4;
/** The band filters follow their params every CONTROL frames. */
const CONTROL = 16;
/** Gain reduction below this (dB) is treated as none. */
const SILENT_GR = 1e-4;

/**
 * Gain reduction in dB (≥ 0) for a band level in dB: nothing under the threshold, `1 − 1/ratio` of
 * the excess over it above (a quadratic soft knee `KNEE` dB wide around it), never more than `range`.
 */
export function deEssReduction(levelDb: number, threshold: number, ratio: number, range: number): number {
  const over = levelDb - threshold;
  const slope = 1 - 1 / Math.max(1, ratio);
  let gr = 0;
  if (2 * Math.abs(over) <= KNEE) {
    const x = over + KNEE / 2;
    gr = (slope * x * x) / (2 * KNEE);
  } else if (over > 0) gr = slope * over;
  return gr > range ? range : gr;
}

/**
 * Split-band de-esser with zero latency. A band-pass at the sibilance frequency (two 12 dB/octave
 * stages, so 1 kHz vowels barely reach the detector) is watched by a stereo-linked peak detector; the
 * static curve turns the level into gain reduction in dB, smoothed with attack and release.
 *
 * Split mode subtracts the *first stage's band* from the voice: `out = x − (1 − g) · band(x)`, which
 * is a bell filter cutting `1 − g` of the band (an analog peaking cut, so its response falls smoothly
 * to nothing away from the centre). With no reduction that is exactly the input (nothing in the signal
 * path colours the voice), and when it works only the band moves, by `g` at its centre. Wideband mode
 * multiplies the whole voice by `g`. Listen outputs the detector's band.
 */
export class DeEsserKernel extends EffectKernel<P> {
  private readonly bandL1 = new Svf();
  private readonly bandL2 = new Svf();
  private readonly bandR1 = new Svf();
  private readonly bandR2 = new Svf();
  /** Peak level of the band (instant attack, a short release so a cycle's zero crossings don't dip it). */
  private readonly level = new EnvelopeFollower(this.sampleRate, 0, 1.5);
  /** The gain reduction (dB) with the Attack and Release knobs' ballistics. */
  private readonly smooth = new EnvelopeFollower(this.sampleRate, 1, 40);
  private readonly meter = new Readings(this.host, ['gr'] as const);
  private freq = -1;
  private q = -1;
  private attack = -1;
  private release = -1;
  private threshold = Number.NaN;
  /** Where the knee starts as a linear level: under it the detector needs no logarithm. */
  private kneeStart = 0;
  private countdown = 0;

  override reset(): void {
    this.bandL1.reset();
    this.bandL2.reset();
    this.bandR1.reset();
    this.bandR2.reset();
    this.level.reset();
    this.smooth.reset();
    this.meter.values.gr = 0;
    this.countdown = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const wide = (p.mode[0] as number) >= 0.5;
    const listen = (p.listen[0] as number) >= 0.5;
    let peakGr = 0;
    for (let i = 0; i < n; i++) {
      if (this.countdown <= 0) {
        this.countdown = CONTROL;
        this.design(at(p.frequency, i), at(p.q, i), at(p.attack, i), at(p.release, i));
      }
      this.countdown--;
      const xl = inL[i] as number;
      const xr = inR[i] as number;
      // One band-pass stage is the band that gets turned down; a second stage sharpens what the detector hears.
      const sl = this.bandL1.process(xl);
      const sr = this.bandR1.process(xr);
      const bl = this.bandL2.process(sl);
      const br = this.bandR2.process(sr);
      if (listen) {
        outL[i] = bl;
        outR[i] = br;
        continue;
      }
      const al = bl < 0 ? -bl : bl;
      const ar = br < 0 ? -br : br;
      const peak = this.level.process(al > ar ? al : ar);
      const threshold = at(p.threshold, i);
      if (threshold !== this.threshold) {
        this.threshold = threshold;
        this.kneeStart = dbToGain(threshold - KNEE / 2);
      }
      const target = peak > this.kneeStart ? deEssReduction(DB_PER_NEPER * Math.log(peak), threshold, at(p.ratio, i), at(p.range, i)) : 0;
      const gr = this.smooth.process(target);
      if (gr > peakGr) peakGr = gr;
      if (gr < SILENT_GR) {
        outL[i] = xl;
        outR[i] = xr;
        continue;
      }
      const g = Math.exp(-NEPER_PER_DB * gr);
      if (wide) {
        outL[i] = xl * g;
        outR[i] = xr * g;
      } else {
        const k = 1 - g;
        outL[i] = xl - k * sl;
        outR[i] = xr - k * sr;
      }
    }
    // The meter holds the biggest reduction of the block and falls 20 dB/s, so brief "s" sounds stay visible.
    const shown = this.meter.values.gr - (20 * n) / this.sampleRate;
    this.meter.values.gr = listen ? 0 : peakGr > shown ? peakGr : shown > 0 ? shown : 0;
    this.meter.tick(n);
  }

  /** Recomputes the filters and the ballistics only when their params changed. */
  private design(freq: number, q: number, attack: number, release: number): void {
    if (freq !== this.freq || q !== this.q) {
      this.freq = freq;
      this.q = q;
      this.bandL1.set('bandpass', freq, q, this.sampleRate);
      this.bandL2.copyDesign(this.bandL1);
      this.bandR1.copyDesign(this.bandL1);
      this.bandR2.copyDesign(this.bandL1);
    }
    if (attack !== this.attack || release !== this.release) {
      this.attack = attack;
      this.release = release;
      this.smooth.setTimes(attack, release);
    }
  }
}
