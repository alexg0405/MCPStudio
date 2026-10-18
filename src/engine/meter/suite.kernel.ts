/**
 * The metering suite's audio-thread math, pure (no DOM, no allocation after construction): BS.1770-4 / EBU R128
 * loudness (momentary, short-term, gated integrated, loudness range), 4× oversampled true peak per channel,
 * stereo correlation, width and mono compatibility per band, a spectrum (the raw FFT power the UI folds into
 * 1/6-octave bands) and a goniometer ring. It reads and writes the shared buffers of `layout.ts`, so the same
 * code runs in the worklet (SharedArrayBuffers) and in Node tests (plain arrays).
 */
import { LinkwitzRiley, LoudnessMeter, StereoSpectrum, TruePeak } from '@agstudio/sdk/worklet';
import {
  BAND_HIGH_HZ,
  BAND_LOW_HZ,
  HISTORY_CAPACITY,
  HISTORY_STEP_SECONDS,
  initReadings,
  R,
  SCOPE_FRAMES,
  SPECTRUM_HOP,
  SPECTRUM_SIZE,
  type MeterViews,
} from './layout';
import { StereoStats } from './stereo-stats';

/** Time constant of the correlation and width meters (seconds). */
const STEREO_SMOOTHING_SECONDS = 0.3;
/** How fast the current true peak falls (dB per second). */
const PEAK_FALL_DB_PER_SECOND = 20;
/** The loudness history pauses after this long without sound, so a stopped song doesn't scroll away (seconds). */
const HISTORY_PAUSE_SECONDS = 3;
/** Below this the absolute gate of BS.1770 treats the audio as silence (LUFS). */
const SILENT_LUFS = -70;
/** Window lengths of the momentary and short-term loudness (seconds): after a restart they still hold the old audio. */
const MOMENTARY_SECONDS = 0.4;
const SHORT_TERM_SECONDS = 3;
/** The loudness range is recomputed this often because it scans a histogram (seconds). */
const RANGE_EVERY_SECONDS = 0.5;
const SILENT_QUANTUM = 128;

/** Per-quantum true peaks (linear): the loudest of each channel, and the loudest that may count for the held maximum. */
interface QuantumPeaks {
  left: number;
  right: number;
  heldLeft: number;
  heldRight: number;
}

const amplitudeToDb = (amplitude: number) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);

/** The three bands the width and the bass phase check look at, from two Linkwitz–Riley splits (they sum flat). */
class BandSplitter {
  private readonly lowLeft = new LinkwitzRiley();
  private readonly lowRight = new LinkwitzRiley();
  private readonly highLeft = new LinkwitzRiley();
  private readonly highRight = new LinkwitzRiley();
  readonly low = new StereoStats();
  readonly mid = new StereoStats();
  readonly high = new StereoStats();

  constructor(sampleRate: number) {
    this.lowLeft.set(BAND_LOW_HZ, sampleRate);
    this.lowRight.set(BAND_LOW_HZ, sampleRate);
    this.highLeft.set(BAND_HIGH_HZ, sampleRate);
    this.highRight.set(BAND_HIGH_HZ, sampleRate);
  }

  add(left: number, right: number, smoothing: number): void {
    this.lowLeft.split(left);
    this.lowRight.split(right);
    this.highLeft.split(this.lowLeft.high);
    this.highRight.split(this.lowRight.high);
    this.low.update(this.lowLeft.low, this.lowRight.low, smoothing);
    this.mid.update(this.highLeft.low, this.highRight.low, smoothing);
    this.high.update(this.highLeft.high, this.highRight.high, smoothing);
  }

  /** Starts from silence (the splitter was idle while the meter ran at basic detail). */
  reset(): void {
    this.lowLeft.reset();
    this.lowRight.reset();
    this.highLeft.reset();
    this.highRight.reset();
    this.low.reset();
    this.mid.reset();
    this.high.reset();
  }
}

/** The whole metering suite for one stereo signal: loudness, true peak, bands, correlation, spectrum and scope. */
export class MeterKernel {
  private readonly loudness: LoudnessMeter;
  private readonly truePeakLeft = new TruePeak();
  private readonly truePeakRight = new TruePeak();
  private readonly bands: BandSplitter;
  private readonly spectrum = new StereoSpectrum(SPECTRUM_SIZE, SPECTRUM_HOP);
  private readonly smoothing: number;
  private readonly whole = new StereoStats();
  private silence = new Float32Array(SILENT_QUANTUM);
  private maxTruePeakLeft = 0;
  private maxTruePeakRight = 0;
  private currentPeakLeftDb = -Infinity;
  private currentPeakRightDb = -Infinity;
  private maxMomentary = -Infinity;
  private maxShortTerm = -Infinity;
  /** Frames after a restart before the peak maximum may count: the detector still reports audio from before it. */
  private peakIgnoreFrames = 0;
  /** Frames after a restart before the loudest-value maximums may count (their windows still hold the old audio). */
  private momentaryIgnoreFrames = 0;
  private shortTermIgnoreFrames = 0;
  private seenResetCount = 0;
  private framesSinceHistoryPoint = 0;
  private historyPoints = 0;
  private secondsSinceSound = Infinity;
  private framesSinceRange = 0;
  private scopeWritePosition = 0;
  private wasFullDetail = false;

  constructor(
    readonly sampleRate: number,
    private readonly views: MeterViews,
  ) {
    this.loudness = new LoudnessMeter(sampleRate, 2);
    this.bands = new BandSplitter(sampleRate);
    this.smoothing = 1 - Math.exp(-1 / (STEREO_SMOOTHING_SECONDS * sampleRate));
    initReadings(views.readings, sampleRate);
    this.seenResetCount = views.readings[R.resetSeq] as number;
  }

  /** True once the main thread asked for the processor to end. */
  get closed(): boolean {
    return (this.views.readings[R.closed] as number) === 1;
  }

  /** Forgets the integrated loudness, the loudness range, the maximums and the history graph (the filters keep running). */
  restart(): void {
    this.loudness.resetIntegrated();
    this.maxTruePeakLeft = this.maxTruePeakRight = 0;
    this.peakIgnoreFrames = 2 * TruePeak.LATENCY;
    this.maxMomentary = this.maxShortTerm = -Infinity;
    this.momentaryIgnoreFrames = MOMENTARY_SECONDS * this.sampleRate;
    this.shortTermIgnoreFrames = SHORT_TERM_SECONDS * this.sampleRate;
    this.views.readings[R.histStart] = this.historyPoints;
    this.secondsSinceSound = Infinity;
  }

  /** Feeds one render quantum (a mono input is used for both channels; a missing input is silence). */
  process(left: Float32Array | undefined, right: Float32Array | undefined, frames: number): void {
    if (frames > this.silence.length) this.silence = new Float32Array(frames);
    const leftInput = left ?? right ?? this.silence;
    const rightInput = right ?? left ?? this.silence;
    this.applyControls();
    const fullDetail = (this.views.readings[R.detail] as number) >= 1;
    const quantumPeaks = this.measureFrames(leftInput, rightInput, frames, fullDetail);
    if (fullDetail && this.spectrum.push(leftInput, rightInput, frames) > 0) {
      this.views.spectrum.set(this.spectrum.power);
      this.views.readings[R.spectrumSeq] = (this.views.readings[R.spectrumSeq] as number) + 1;
    }
    this.trackPeaks(quantumPeaks, frames);
    this.trackLoudness(frames);
    this.publish(fullDetail);
  }

  /** Reacts to the main thread's controls: a reset request, and a switch to full detail. */
  private applyControls(): void {
    const readings = this.views.readings;
    const resetCount = readings[R.resetSeq] as number;
    if (resetCount !== this.seenResetCount) {
      this.seenResetCount = resetCount;
      this.restart();
    }
    const fullDetail = (readings[R.detail] as number) >= 1;
    if (fullDetail && !this.wasFullDetail) this.startFullDetail();
    this.wasFullDetail = fullDetail;
  }

  /** The band filters, the spectrum and the scope were idle: they start from silence. */
  private startFullDetail(): void {
    this.bands.reset();
    this.spectrum.reset();
    this.views.scope.fill(0);
    this.scopeWritePosition = 0;
  }

  private readonly quantumPeaks: QuantumPeaks = { left: 0, right: 0, heldLeft: 0, heldRight: 0 };

  /** The per-sample work: loudness, true peaks, stereo statistics, bands and the scope ring. */
  private measureFrames(left: Float32Array, right: Float32Array, frames: number, fullDetail: boolean): QuantumPeaks {
    const peaks = this.quantumPeaks;
    peaks.left = peaks.right = peaks.heldLeft = peaks.heldRight = 0;
    for (let i = 0; i < frames; i++) {
      const leftSample = left[i] as number;
      const rightSample = right[i] as number;
      this.loudness.process(leftSample, rightSample);
      this.measurePeaks(leftSample, rightSample, peaks);
      this.whole.update(leftSample, rightSample, this.smoothing);
      if (!fullDetail) continue;
      this.bands.add(leftSample, rightSample, this.smoothing);
      this.writeScope(leftSample, rightSample);
    }
    return peaks;
  }

  private measurePeaks(leftSample: number, rightSample: number, peaks: QuantumPeaks): void {
    const leftPeak = this.truePeakLeft.process(leftSample);
    const rightPeak = this.truePeakRight.process(rightSample);
    if (leftPeak > peaks.left) peaks.left = leftPeak;
    if (rightPeak > peaks.right) peaks.right = rightPeak;
    if (this.peakIgnoreFrames > 0) {
      this.peakIgnoreFrames--;
      return;
    }
    if (leftPeak > peaks.heldLeft) peaks.heldLeft = leftPeak;
    if (rightPeak > peaks.heldRight) peaks.heldRight = rightPeak;
  }

  private writeScope(leftSample: number, rightSample: number): void {
    const at = this.scopeWritePosition * 2;
    this.views.scope[at] = leftSample;
    this.views.scope[at + 1] = rightSample;
    this.scopeWritePosition = this.scopeWritePosition + 1 === SCOPE_FRAMES ? 0 : this.scopeWritePosition + 1;
  }

  /** The maximum since the restart, and the falling "now" value, per channel. */
  private trackPeaks(peaks: QuantumPeaks, frames: number): void {
    if (peaks.heldLeft > this.maxTruePeakLeft) this.maxTruePeakLeft = peaks.heldLeft;
    if (peaks.heldRight > this.maxTruePeakRight) this.maxTruePeakRight = peaks.heldRight;
    const fallDb = (PEAK_FALL_DB_PER_SECOND * frames) / this.sampleRate;
    const leftDb = amplitudeToDb(peaks.left);
    const rightDb = amplitudeToDb(peaks.right);
    this.currentPeakLeftDb = Math.max(leftDb, this.currentPeakLeftDb - fallDb);
    this.currentPeakRightDb = Math.max(rightDb, this.currentPeakRightDb - fallDb);
  }

  /** Maximums, the history graph and the loudness range. */
  private trackLoudness(frames: number): void {
    const { momentary, shortTerm } = this.loudness;
    this.momentaryIgnoreFrames = Math.max(0, this.momentaryIgnoreFrames - frames);
    this.shortTermIgnoreFrames = Math.max(0, this.shortTermIgnoreFrames - frames);
    if (this.momentaryIgnoreFrames === 0 && momentary > this.maxMomentary) this.maxMomentary = momentary;
    if (this.shortTermIgnoreFrames === 0 && shortTerm > this.maxShortTerm) this.maxShortTerm = shortTerm;
    if (momentary > SILENT_LUFS) this.secondsSinceSound = 0;
    else this.secondsSinceSound += frames / this.sampleRate;
    this.writeHistory(frames, momentary, shortTerm);
    this.framesSinceRange += frames;
    if (this.framesSinceRange >= RANGE_EVERY_SECONDS * this.sampleRate) {
      this.framesSinceRange = 0;
      this.views.readings[R.range] = this.loudness.range;
    }
  }

  /** One point (momentary, short-term) every 100 ms while there is sound. */
  private writeHistory(frames: number, momentary: number, shortTerm: number): void {
    this.framesSinceHistoryPoint += frames;
    const framesPerPoint = HISTORY_STEP_SECONDS * this.sampleRate;
    while (this.framesSinceHistoryPoint >= framesPerPoint) {
      this.framesSinceHistoryPoint -= framesPerPoint;
      if (this.secondsSinceSound >= HISTORY_PAUSE_SECONDS) continue;
      const at = (this.historyPoints % HISTORY_CAPACITY) * 2;
      this.views.history[at] = momentary;
      this.views.history[at + 1] = shortTerm;
      this.historyPoints++;
    }
  }

  private publish(fullDetail: boolean): void {
    const readings = this.views.readings;
    readings[R.momentary] = this.loudness.momentary;
    readings[R.shortTerm] = this.loudness.shortTerm;
    readings[R.integrated] = this.loudness.integrated;
    readings[R.truePeakL] = amplitudeToDb(this.maxTruePeakLeft);
    readings[R.truePeakR] = amplitudeToDb(this.maxTruePeakRight);
    readings[R.peakL] = this.currentPeakLeftDb;
    readings[R.peakR] = this.currentPeakRightDb;
    readings[R.maxMomentary] = this.maxMomentary;
    readings[R.maxShortTerm] = this.maxShortTerm;
    readings[R.correlation] = this.whole.correlation();
    readings[R.monoLoss] = this.whole.monoLossDb();
    if (fullDetail) {
      readings[R.widthLow] = this.bands.low.width();
      readings[R.widthMid] = this.bands.mid.width();
      readings[R.widthHigh] = this.bands.high.width();
      readings[R.corrLow] = this.bands.low.correlation();
      readings[R.monoLossLow] = this.bands.low.monoLossDb();
      readings[R.levelLow] = this.bands.low.levelDb();
      readings[R.scopePos] = this.scopeWritePosition;
    }
    readings[R.histCount] = this.historyPoints;
    readings[R.blocks] = (readings[R.blocks] as number) + 1;
  }
}
