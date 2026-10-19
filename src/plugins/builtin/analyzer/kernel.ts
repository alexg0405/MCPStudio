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

type Params = typeof analyzerParams;

/** The Listen param's options, positions in LISTEN (params.ts): what the output carries. */
const LISTEN_STEREO = 0;
const LISTEN_MONO = 1;
const LISTEN_SIDE = 2;
const LISTEN_LOWS = 3;
const LISTEN_HIGHS = 4;
const LISTEN_LEFT = 5;
const LISTEN_RIGHT = 6;
/** Time constant of the correlation meter. */
const CORRELATION_SEC = 0.3;
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
export class AnalyzerKernel extends EffectKernel<Params> {
  private readonly loudness = new LoudnessMeter(this.sampleRate, 2);
  private readonly leftTruePeak = new TruePeak();
  private readonly rightTruePeak = new TruePeak();
  private readonly leftLowSplit = new LinkwitzRiley().set(LOWS_HZ, this.sampleRate);
  private readonly rightLowSplit = new LinkwitzRiley().set(LOWS_HZ, this.sampleRate);
  private readonly leftHighSplit = new LinkwitzRiley().set(HIGHS_HZ, this.sampleRate);
  private readonly rightHighSplit = new LinkwitzRiley().set(HIGHS_HZ, this.sampleRate);
  private readonly meter = new Readings(this.host, READINGS);
  private readonly correlationSmoothing = 1 - Math.exp(-1 / (CORRELATION_SEC * this.sampleRate));
  private leftPower = 0;
  private rightPower = 0;
  private crossPower = 0;
  private maxTruePeak = 0;
  /** Frames the peak hold ignores after a restart (the detector still holds audio from before). */
  private holdIgnoreFrames = 0;
  private wasPlaying = false;

  constructor(host: KernelHost) {
    super(host);
    const readings = this.meter.values;
    readings.momentary =
      readings.shortTerm =
      readings.integrated =
      readings.truePeak =
      readings.peakL =
      readings.peakR =
        -Infinity;
    readings.correlation = 0;
  }

  override reset(): void {
    this.loudness.reset();
    this.leftTruePeak.reset();
    this.rightTruePeak.reset();
    for (const x of [this.leftLowSplit, this.rightLowSplit, this.leftHighSplit, this.rightHighSplit]) x.reset();
    this.leftPower = this.rightPower = this.crossPower = 0;
    this.maxTruePeak = 0;
  }

  override transportChanged(): void {
    const isPlaying = this.transport.playing;
    if (isPlaying && !this.wasPlaying) {
      // A new playback, a new measurement.
      this.loudness.resetIntegrated();
      this.maxTruePeak = 0;
      this.holdIgnoreFrames = 2 * TruePeak.LATENCY;
    }
    this.wasPlaying = isPlaying;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const listenMode = Math.round(params.listen[0] as number);
    const smoothing = this.correlationSmoothing;
    let blockPeakLeft = 0;
    let blockPeakRight = 0;
    for (let i = 0; i < frameCount; i++) {
      const leftSample = inLeft[i] as number;
      const rightSample = inRight[i] as number;
      this.loudness.process(leftSample, rightSample);
      const leftTruePeakSample = this.leftTruePeak.process(leftSample);
      const rightTruePeakSample = this.rightTruePeak.process(rightSample);
      if (leftTruePeakSample > blockPeakLeft) blockPeakLeft = leftTruePeakSample;
      if (rightTruePeakSample > blockPeakRight) blockPeakRight = rightTruePeakSample;
      this.leftPower += (leftSample * leftSample - this.leftPower) * smoothing;
      this.rightPower += (rightSample * rightSample - this.rightPower) * smoothing;
      this.crossPower += (leftSample * rightSample - this.crossPower) * smoothing;
      // The listening filters only run in their own modes (switching to one starts it from silence).
      if (listenMode === LISTEN_LOWS) {
        this.leftLowSplit.split(leftSample);
        this.rightLowSplit.split(rightSample);
      } else if (listenMode === LISTEN_HIGHS) {
        this.leftHighSplit.split(leftSample);
        this.rightHighSplit.split(rightSample);
      }
      switch (listenMode) {
        case LISTEN_STEREO:
          outLeft[i] = leftSample;
          outRight[i] = rightSample;
          break;
        case LISTEN_MONO:
          outLeft[i] = outRight[i] = 0.5 * (leftSample + rightSample);
          break;
        case LISTEN_SIDE:
          outLeft[i] = outRight[i] = 0.5 * (leftSample - rightSample);
          break;
        case LISTEN_LOWS:
          outLeft[i] = this.leftLowSplit.low;
          outRight[i] = this.rightLowSplit.low;
          break;
        case LISTEN_HIGHS:
          outLeft[i] = this.leftHighSplit.high;
          outRight[i] = this.rightHighSplit.high;
          break;
        case LISTEN_LEFT:
          outLeft[i] = outRight[i] = leftSample;
          break;
        case LISTEN_RIGHT:
          outLeft[i] = outRight[i] = rightSample;
          break;
        default:
          outLeft[i] = leftSample;
          outRight[i] = rightSample;
      }
    }
    if (this.holdIgnoreFrames > 0) this.holdIgnoreFrames -= frameCount;
    else {
      if (blockPeakLeft > this.maxTruePeak) this.maxTruePeak = blockPeakLeft;
      if (blockPeakRight > this.maxTruePeak) this.maxTruePeak = blockPeakRight;
    }
    const readings = this.meter.values;
    const fallDb = (PEAK_FALL_DB * frameCount) / this.sampleRate;
    const leftPeakDb = toDb(blockPeakLeft);
    const rightPeakDb = toDb(blockPeakRight);
    readings.peakL = leftPeakDb > readings.peakL - fallDb ? leftPeakDb : readings.peakL - fallDb;
    readings.peakR = rightPeakDb > readings.peakR - fallDb ? rightPeakDb : readings.peakR - fallDb;
    readings.truePeak = toDb(this.maxTruePeak);
    readings.momentary = this.loudness.momentary;
    readings.shortTerm = this.loudness.shortTerm;
    readings.integrated = this.loudness.integrated;
    const energy = Math.sqrt(this.leftPower * this.rightPower);
    readings.correlation = energy > 1e-10 ? Math.max(-1, Math.min(1, this.crossPower / energy)) : 0;
    this.meter.tick(frameCount);
  }
}
