import { at, dbToGain, EffectKernel, LookaheadLimiter, Oversampler, Readings, type ParamBlock } from '@agstudio/sdk/worklet';
import { lookaheadFrames, MAX_CLIP_DB, type maximizerParams } from './params';

type P = typeof maximizerParams;

/** The soft clip runs at 2× the sample rate, so what it adds does not fold back into the highs (4× measured the same, at twice the cost; none folded a little more of it back). */
const OVERSAMPLING = 2;
/** Below this the clip is off (and the audio skips the oversampler). */
const CLIP_OFF_DB = 0.05;

/**
 * The soft clip curve: the signal passes untouched up to `lo`, then bends along a smooth cubic (the
 * slope eases from 1 to 0) until `top` (the level the first stage never lets the audio past), where
 * the output is exactly `ceil`; anything above stays at `ceil`. Odd-symmetric. `span` is `top − lo`.
 */
export function softClipShape(x: number, lo: number, top: number, ceil: number, span: number): number {
  const a = x < 0 ? -x : x;
  if (a <= lo) return x;
  let y: number;
  if (a >= top) y = ceil;
  else {
    const u = (a - lo) / span;
    const u2 = u * u;
    const u3 = u2 * u;
    y = lo * (2 * u3 - 3 * u2 + 1) + span * (u3 - 2 * u2 + u) + ceil * (3 * u2 - 2 * u3);
  }
  return x < 0 ? -y : y;
}

/**
 * Maximizer: gets a mix louder with less squeezing than a limiter alone. Two stages:
 * 1. a look-ahead limiter (the SDK's `LookaheadLimiter`, stereo-linked, true peaks) brings the peaks to
 *    `clip` dB over the ceiling, with the same smooth ramps and release as the Limiter plugin;
 * 2. a soft clip, at 2× oversampling, rounds those last `clip` dB (and the `knee` dB under the ceiling) off.
 * The limiter alone would have to turn the whole mix down for every kick; the clip takes the top of the peaks
 * instead, as a few harmonics on the transient. How much it may take is bounded by `clip`, so it can never
 * crush a mix. Put a Limiter with the same ceiling after it: the soft clip's output filter overshoots a little, and the Limiter takes that off.
 */
export class MaximizerKernel extends EffectKernel<P> {
  private readonly core = new LookaheadLimiter(lookaheadFrames(this.sampleRate));
  /** Total delay in frames (the reported latency). */
  readonly latency = this.core.latency;
  private readonly os = [new Oversampler(OVERSAMPLING), new Oversampler(OVERSAMPLING)];
  // Cached param conversions.
  private inputDb = Number.NaN;
  private inputGain = 1;
  private ceilingDb = Number.NaN;
  private clipDb = Number.NaN;
  private kneeDb = Number.NaN;
  private releaseMs = Number.NaN;
  /** Linear: where the first stage holds the peaks, the soft clip's output ceiling, where its knee starts, and the knee's span. */
  private top = 1;
  private ceil = 1;
  private lo = 1;
  private span = 0;
  private clipOn = false;
  /** Gain reduction of the limiter stage, and the dB the soft clip took off the loudest peak, for the editor. */
  private readonly meter = new Readings(this.host, ['gr', 'clip'] as const);

  override reset(): void {
    this.core.reset();
    for (const o of this.os) o.reset();
    this.meter.values.gr = 0;
    this.meter.values.clip = 0;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const core = this.core;
    const osL = this.os[0] as Oversampler;
    const osR = this.os[1] as Oversampler;
    core.minGain = 1;
    let peakBefore = 0;
    let peakAfter = 0;
    for (let i = 0; i < n; i++) {
      this.params(at(p.input, i), at(p.ceiling, i), at(p.clip, i), at(p.knee, i), at(p.release, i));
      core.step((inL[i] as number) * this.inputGain, (inR[i] as number) * this.inputGain, this.top, true);
      const l = core.outL;
      const r = core.outR;
      if (!this.clipOn) {
        outL[i] = l;
        outR[i] = r;
        continue;
      }
      const lo = this.lo;
      const top = this.top;
      const ceil = this.ceil;
      const span = this.span;
      osL.up(l);
      osR.up(r);
      const bl = osL.buffer;
      const br = osR.buffer;
      for (let k = 0; k < OVERSAMPLING; k++) {
        const a = bl[k] as number;
        const b = br[k] as number;
        const ya = softClipShape(a, lo, top, ceil, span);
        const yb = softClipShape(b, lo, top, ceil, span);
        bl[k] = ya;
        br[k] = yb;
        const m = Math.max(a < 0 ? -a : a, b < 0 ? -b : b);
        if (m > peakBefore) peakBefore = m;
        const q = Math.max(ya < 0 ? -ya : ya, yb < 0 ? -yb : yb);
        if (q > peakAfter) peakAfter = q;
      }
      outL[i] = osL.down();
      outR[i] = osR.down();
    }
    const minGain = core.minGain;
    const gr = minGain < 1 ? -20 * Math.log10(minGain) : 0;
    const decay = (20 * n) / this.sampleRate;
    const shown = this.meter.values.gr - decay;
    this.meter.values.gr = gr > shown ? gr : shown > 0 ? shown : 0;
    const clipped = peakAfter > 0 && peakBefore > peakAfter ? 20 * Math.log10(peakBefore / peakAfter) : 0;
    const shownClip = this.meter.values.clip - decay;
    this.meter.values.clip = clipped > shownClip ? clipped : shownClip > 0 ? shownClip : 0;
    this.meter.tick(n);
  }

  private params(inputDb: number, ceilingDb: number, clipDb: number, kneeDb: number, releaseMs: number): void {
    if (inputDb !== this.inputDb) {
      this.inputDb = inputDb;
      this.inputGain = dbToGain(inputDb);
    }
    if (ceilingDb !== this.ceilingDb || clipDb !== this.clipDb || kneeDb !== this.kneeDb) {
      if (clipDb >= CLIP_OFF_DB && !this.clipOn) for (const o of this.os) o.reset();
      this.ceilingDb = ceilingDb;
      this.clipDb = clipDb;
      this.kneeDb = kneeDb;
      const ceil = dbToGain(ceilingDb);
      const depth = Math.min(MAX_CLIP_DB, Math.max(0, clipDb));
      this.clipOn = depth >= CLIP_OFF_DB;
      this.ceil = ceil;
      this.top = this.clipOn ? ceil * dbToGain(depth) : ceil;
      // The knee starts `kneeDb` under the ceiling, and far enough down that the cubic stays monotonic
      // (its end slope is 0, so the curve needs at least a third of the way's rise: knee span ≥ half the clip's).
      const knee = ceil * dbToGain(-Math.max(0.1, kneeDb));
      this.lo = Math.min(knee, ceil - (this.top - ceil) / 2);
      this.span = this.top - this.lo;
    }
    if (releaseMs !== this.releaseMs) {
      this.releaseMs = releaseMs;
      this.core.releaseCoef = 1 - Math.exp(-1000 / (Math.max(0.1, releaseMs) * this.sampleRate));
    }
  }
}
