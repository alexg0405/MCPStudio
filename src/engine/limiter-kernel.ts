/**
 * Master safety limiter: ~1.3 ms look-ahead brickwall at -0.3 dBFS so nothing you build (or a
 * runaway plugin) can blast your speakers. Written as an SDK EffectKernel like any plugin.
 */
import { EffectKernel, dbToGain, p, type KernelHost, type ParamBlock } from '@agstudio/sdk/worklet';
import { LIMITER_LOOKAHEAD_SEC } from './limiter-id';

export { LIMITER_ID } from './limiter-id';
/** The limiter's one param: the ceiling (dB) it holds the output under. */
export const limiterParams = {
  ceiling: p.float(-12, 0, -0.3, { label: 'Ceiling', unit: 'dB' }),
};

/** A look-ahead brickwall limiter (see the file comment). */
export class SafetyLimiterKernel extends EffectKernel<typeof limiterParams> {
  private readonly look: number;
  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private w = 0;
  // Monotonic deque (ring) of recent peaks for an O(1) sliding-window maximum.
  private readonly qVal: Float32Array;
  private readonly qIdx: Float64Array;
  private qHead = 0;
  private qLen = 0;
  private t = 0;
  private gain = 1;
  private readonly attack: number;
  private readonly release: number;

  constructor(host: KernelHost) {
    super(host);
    this.look = Math.max(1, Math.round(LIMITER_LOOKAHEAD_SEC * host.sampleRate));
    this.delayL = new Float32Array(this.look);
    this.delayR = new Float32Array(this.look);
    this.qVal = new Float32Array(this.look + 2);
    this.qIdx = new Float64Array(this.look + 2);
    this.attack = 1 - Math.exp(-1 / (0.0003 * host.sampleRate));
    this.release = 1 - Math.exp(-1 / (0.05 * host.sampleRate));
  }

  override reset(): void {
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.qLen = 0;
    this.gain = 1;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, params: ParamBlock<typeof limiterParams>): void {
    const ceiling = dbToGain(params.ceiling[0] as number);
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? input[0]) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? output[0]) as Float32Array;
    const cap = this.qVal.length;
    for (let i = 0; i < n; i++) {
      const xl = inL[i] as number;
      const xr = inR[i] as number;
      const peak = Math.max(Math.abs(xl), Math.abs(xr));
      // Push the new peak, dropping smaller ones from the back.
      while (this.qLen > 0 && (this.qVal[(this.qHead + this.qLen - 1) % cap] as number) <= peak) this.qLen--;
      const tail = (this.qHead + this.qLen) % cap;
      this.qVal[tail] = peak;
      this.qIdx[tail] = this.t;
      this.qLen++;
      // Expire peaks older than the look-ahead window.
      while ((this.qIdx[this.qHead] as number) < this.t - this.look) {
        this.qHead = (this.qHead + 1) % cap;
        this.qLen--;
      }
      const windowMax = this.qVal[this.qHead] as number;
      const target = windowMax > ceiling ? ceiling / windowMax : 1;
      this.gain += (target - this.gain) * (target < this.gain ? this.attack : this.release);

      const dl = this.delayL[this.w] as number;
      const dr = this.delayR[this.w] as number;
      this.delayL[this.w] = xl;
      this.delayR[this.w] = xr;
      this.w = this.w + 1 === this.look ? 0 : this.w + 1;

      let yl = dl * this.gain;
      let yr = dr * this.gain;
      // Final clamp: guarantees the ceiling even if the gain hasn't fully caught up.
      if (yl > ceiling) yl = ceiling;
      else if (yl < -ceiling) yl = -ceiling;
      if (yr > ceiling) yr = ceiling;
      else if (yr < -ceiling) yr = -ceiling;
      outL[i] = yl;
      outR[i] = yr;
      this.t++;
    }
  }
}
