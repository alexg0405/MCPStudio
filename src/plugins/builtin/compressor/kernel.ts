import { at, dbToGain, EffectKernel, EnvelopeFollower, Svf, type ParamBlock } from '@agstudio/sdk/worklet';
import type { compressorParams } from './params';

type P = typeof compressorParams;

/** 20 / ln(10): dB = DB_PER_NEPER · ln(gain). */
const DB_PER_NEPER = 8.685889638065035;
/** Below this the key counts as silence (−120 dBFS). */
const FLOOR = 1e-6;
/** The SC filter's lowest setting means "off". */
export const SC_FILTER_OFF = 20;

/**
 * Gain reduction in dB (≥ 0) of the static curve for a level in dB: hard knee above the threshold,
 * a quadratic soft knee `knee` dB wide around it (Giannoulis, Massberg & Reiss 2012).
 */
export function gainReduction(levelDb: number, threshold: number, ratio: number, knee: number): number {
  const over = levelDb - threshold;
  const slope = 1 - 1 / Math.max(1, ratio);
  if (knee > 0 && 2 * Math.abs(over) <= knee) {
    const x = over + knee / 2;
    return (slope * x * x) / (2 * knee);
  }
  return over > 0 ? slope * over : 0;
}

/**
 * Feed-forward compressor with zero latency (no look-ahead, so it adds no delay to the mix). The key
 * (the sidechain input: the chosen track, or the effect's own input when none is chosen) goes
 * through a 12 dB/octave high-pass (off at its 20 Hz minimum), a stereo-linked peak detector and
 * the static curve; the gain
 * reduction is smoothed in dB with attack/release time constants (smooth branching, so the release
 * sets how fast the level recovers whatever the attack). Listen outputs the filtered key.
 */
export class CompressorKernel extends EffectKernel<P> {
  private readonly hpL = new Svf();
  private readonly hpR = new Svf();
  private readonly smooth = new EnvelopeFollower(this.sampleRate, 5, 150);
  private cutoff = -1;
  private attack = -1;
  private release = -1;

  override reset(): void {
    this.hpL.reset();
    this.hpR.reset();
    this.smooth.reset();
  }

  process(
    input: Float32Array[],
    output: Float32Array[],
    n: number,
    p: ParamBlock<P>,
    sidechain?: Float32Array[],
  ): void {
    const key = sidechain ?? input;
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const kL = key[0] as Float32Array;
    const kR = (key[1] ?? kL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const listen = (p.listen[0] as number) >= 0.5;
    for (let i = 0; i < n; i++) {
      const cutoff = at(p.scFilter, i);
      this.coefficients(cutoff, at(p.attack, i), at(p.release, i));
      // The filters always run (switching the filter on doesn't start from a cold state).
      const hl = this.hpL.process(kL[i] as number);
      const hr = this.hpR.process(kR[i] as number);
      const off = cutoff <= SC_FILTER_OFF;
      const fl = off ? (kL[i] as number) : hl;
      const fr = off ? (kR[i] as number) : hr;
      if (listen) {
        outL[i] = fl;
        outR[i] = fr;
        continue;
      }
      const al = fl < 0 ? -fl : fl;
      const ar = fr < 0 ? -fr : fr;
      const level = al > ar ? al : ar;
      const levelDb = level > FLOOR ? DB_PER_NEPER * Math.log(level) : -120;
      const gr = this.smooth.process(gainReduction(levelDb, at(p.threshold, i), at(p.ratio, i), at(p.knee, i)));
      const db = at(p.makeup, i) - gr;
      const g = db === 0 ? 1 : dbToGain(db);
      outL[i] = (inL[i] as number) * g;
      outR[i] = (inR[i] as number) * g;
    }
  }

  /** Recomputes filter and ballistics coefficients only when their params change. */
  private coefficients(cutoff: number, attack: number, release: number): void {
    if (cutoff !== this.cutoff) {
      this.cutoff = cutoff;
      this.hpL.set('highpass', cutoff, Math.SQRT1_2, this.sampleRate);
      this.hpR.set('highpass', cutoff, Math.SQRT1_2, this.sampleRate);
    }
    if (attack !== this.attack || release !== this.release) {
      this.attack = attack;
      this.release = release;
      this.smooth.setTimes(attack, release);
    }
  }
}
