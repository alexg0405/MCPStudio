import {
  EffectKernel,
  LinkwitzRiley,
  LoudnessMeter,
  Readings,
  TruePeak,
  type KernelHost,
  type ParamBlock,
} from '@agstudio/sdk/worklet';
import { HIGHS_HZ, LOWS_HZ, READINGS, type analyzerParams } from './params';

type P = typeof analyzerParams;

const STEREO = 0;
const MONO = 1;
const SIDE = 2;
const LOWS = 3;
const HIGHS = 4;
const LEFT = 5;
const RIGHT = 6;
/** Time constant of the correlation meter. */
const CORRELATION_SECONDS = 0.3;
/** How fast the peak readings fall, dB per second. */
const PEAK_FALL_DB = 20;

const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/**
 * Pass-through analyzer. It measures its input exactly (every sample): loudness (BS.1770 momentary,
 * short-term and gated integrated LUFS), true peak (4× oversampled; the maximum since the song
 * started, and a falling per-channel peak) and stereo correlation (+1 mono, 0 unrelated, −1 out of
 * phase), and publishes them ~30 times a second for its editor. Integrated loudness and the peak
 * hold restart when the song starts playing. The Listen modes only change what you hear.
 */
export class AnalyzerKernel extends EffectKernel<P> {
  private readonly loudness = new LoudnessMeter(this.sampleRate, 2);
  private readonly tpL = new TruePeak();
  private readonly tpR = new TruePeak();
  private readonly lowL = new LinkwitzRiley().set(LOWS_HZ, this.sampleRate);
  private readonly lowR = new LinkwitzRiley().set(LOWS_HZ, this.sampleRate);
  private readonly highL = new LinkwitzRiley().set(HIGHS_HZ, this.sampleRate);
  private readonly highR = new LinkwitzRiley().set(HIGHS_HZ, this.sampleRate);
  private readonly meter = new Readings(this.host, READINGS);
  private readonly corrCoef = 1 - Math.exp(-1 / (CORRELATION_SECONDS * this.sampleRate));
  private ll = 0;
  private rr = 0;
  private lr = 0;
  private maxPeak = 0;
  /** Frames the peak hold ignores after a restart (the detector still holds audio from before). */
  private holdIgnore = 0;
  private wasPlaying = false;

  constructor(host: KernelHost) {
    super(host);
    const v = this.meter.values;
    v.momentary = v.shortTerm = v.integrated = v.truePeak = v.peakL = v.peakR = -Infinity;
    v.correlation = 0;
  }

  override reset(): void {
    this.loudness.reset();
    this.tpL.reset();
    this.tpR.reset();
    for (const x of [this.lowL, this.lowR, this.highL, this.highR]) x.reset();
    this.ll = this.rr = this.lr = 0;
    this.maxPeak = 0;
  }

  override transportChanged(): void {
    const playing = this.transport.playing;
    if (playing && !this.wasPlaying) {
      // A new playback, a new measurement.
      this.loudness.resetIntegrated();
      this.maxPeak = 0;
      this.holdIgnore = 2 * TruePeak.LATENCY;
    }
    this.wasPlaying = playing;
  }

  process(input: Float32Array[], output: Float32Array[], n: number, p: ParamBlock<P>): void {
    const inL = input[0] as Float32Array;
    const inR = (input[1] ?? inL) as Float32Array;
    const outL = output[0] as Float32Array;
    const outR = (output[1] ?? outL) as Float32Array;
    const listen = Math.round(p.listen[0] as number);
    const c = this.corrCoef;
    let peakL = 0;
    let peakR = 0;
    for (let i = 0; i < n; i++) {
      const l = inL[i] as number;
      const r = inR[i] as number;
      this.loudness.process(l, r);
      const a = this.tpL.process(l);
      const b = this.tpR.process(r);
      if (a > peakL) peakL = a;
      if (b > peakR) peakR = b;
      this.ll += (l * l - this.ll) * c;
      this.rr += (r * r - this.rr) * c;
      this.lr += (l * r - this.lr) * c;
      // The listening filters only run in their own modes (switching to one starts it from silence).
      if (listen === LOWS) {
        this.lowL.split(l);
        this.lowR.split(r);
      } else if (listen === HIGHS) {
        this.highL.split(l);
        this.highR.split(r);
      }
      switch (listen) {
        case STEREO:
          outL[i] = l;
          outR[i] = r;
          break;
        case MONO:
          outL[i] = outR[i] = 0.5 * (l + r);
          break;
        case SIDE:
          outL[i] = outR[i] = 0.5 * (l - r);
          break;
        case LOWS:
          outL[i] = this.lowL.low;
          outR[i] = this.lowR.low;
          break;
        case HIGHS:
          outL[i] = this.highL.high;
          outR[i] = this.highR.high;
          break;
        case LEFT:
          outL[i] = outR[i] = l;
          break;
        case RIGHT:
          outL[i] = outR[i] = r;
          break;
        default:
          outL[i] = l;
          outR[i] = r;
      }
    }
    if (this.holdIgnore > 0) this.holdIgnore -= n;
    else {
      if (peakL > this.maxPeak) this.maxPeak = peakL;
      if (peakR > this.maxPeak) this.maxPeak = peakR;
    }
    const v = this.meter.values;
    const fall = (PEAK_FALL_DB * n) / this.sampleRate;
    const dl = toDb(peakL);
    const dr = toDb(peakR);
    v.peakL = dl > v.peakL - fall ? dl : v.peakL - fall;
    v.peakR = dr > v.peakR - fall ? dr : v.peakR - fall;
    v.truePeak = toDb(this.maxPeak);
    v.momentary = this.loudness.momentary;
    v.shortTerm = this.loudness.shortTerm;
    v.integrated = this.loudness.integrated;
    const energy = Math.sqrt(this.ll * this.rr);
    v.correlation = energy > 1e-10 ? Math.max(-1, Math.min(1, this.lr / energy)) : 0;
    this.meter.tick(n);
  }
}
