// Linkwitz-Riley crossover (24 dB/octave). Allocation-free; usable on any thread.
import { Svf } from './svf';

/** Butterworth Q: two of these in series make a Linkwitz-Riley section. */
const BUTTERWORTH_Q = Math.SQRT1_2;

/**
 * A 4th-order Linkwitz-Riley crossover: `split(x)` leaves the bands in `low` and `high`, each
 * −6 dB at the crossover frequency and falling 24 dB/octave beyond it. The two bands sum to an
 * allpass: the same level at every frequency (flat), with the phase shift `allpass(x)` applies.
 *
 * For three or more bands, split the high band again and pass the bands below through the
 * higher crossovers' `allpass()` so every band has the same phase and the sum stays flat:
 *
 * ```ts
 * a.split(x);  b.split(a.high);
 * const low = b.allpass(a.low), mid = b.low, high = b.high; // low + mid + high is flat
 * ```
 */
export class LinkwitzRiley {
  /** Low band of the last `split()`. */
  low = 0;
  /** High band of the last `split()`. */
  high = 0;
  /** First Butterworth stage, shared: its low- and high-pass outputs come from one state. */
  private readonly first = new Svf();
  private readonly lowStage = new Svf();
  private readonly highStage = new Svf();
  private readonly phase = new Svf();
  private freq = -1;
  private rate = -1;

  set(freq: number, sampleRate: number): this {
    if (freq === this.freq && sampleRate === this.rate) return this;
    this.freq = freq;
    this.rate = sampleRate;
    this.first.set('lowpass', freq, BUTTERWORTH_Q, sampleRate);
    this.lowStage.set('lowpass', freq, BUTTERWORTH_Q, sampleRate);
    this.highStage.set('highpass', freq, BUTTERWORTH_Q, sampleRate);
    this.phase.set('allpass', freq, BUTTERWORTH_Q, sampleRate);
    return this;
  }

  /** Splits one sample into `low` and `high`. */
  split(x: number): void {
    const first = this.first;
    first.process(x);
    this.low = this.lowStage.process(first.low);
    this.high = this.highStage.process(first.high);
  }

  /**
   * The phase response of `low + high` alone (its own state, separate from `split`): run the
   * bands of an earlier split through it so they line up with this crossover's bands.
   */
  allpass(x: number): number {
    return this.phase.process(x);
  }

  reset(): void {
    this.first.reset();
    this.lowStage.reset();
    this.highStage.reset();
    this.phase.reset();
    this.low = 0;
    this.high = 0;
  }
}
