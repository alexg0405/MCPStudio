import { decimate } from '../filters';
import { Yin, hzToMidi, pitchDecimation } from '../pitch';
import { ampToDb, median } from './math';
import { HOP_SEC, VOICE_THRESHOLDS } from './thresholds';

const T = VOICE_THRESHOLDS;

/** The pitch tracker's range (Hz): the fundamentals of a voice. */
const YIN_MIN_HZ = 40;
const YIN_MAX_HZ = 1000;
/** YIN's integration window is one period of the lowest pitch, but never under this many seconds. */
const YIN_MIN_WINDOW_SEC = 0.01;
/** Frames whose mean square is under this are unvoiced without running YIN (digital silence). */
const YIN_ENERGY_FLOOR = 1e-12;

/** Periodicity is the median over the frames that start in the first this-many seconds of a sound. */
const PERIODICITY_SPAN_SEC = 0.035;
/** The sound "just before" an onset is read from this far back to this far back (s). */
const BEFORE_FROM_SEC = 0.06;
const BEFORE_TO_SEC = 0.03;
/** The last frame of a sound's pitch track ends this long before the sound does (the YIN window reaches ahead). */
const PITCH_TAIL_MARGIN_SEC = 0.015;

/** What was playing just before an onset. */
export interface SoundBefore {
  /** Median f0 of its voiced frames (Hz), 0 if unvoiced. */
  f0: number;
  /** Median periodicity 0..1. */
  periodicity: number;
}

/** MIDI pitch per frame over a span of the recording. */
export interface MidiTrack {
  /** The frame the first value belongs to. */
  from: number;
  /** MIDI pitch (fractional) per frame; NaN where the frame is not confidently pitched. */
  midi: Float64Array;
}

/**
 * The pitch track of a recording: one YIN estimate per ~5 ms frame, computed only for the frames
 * that something asks about (most of a drum recording is never looked at) and kept for next time.
 * Frame i is centered at i × hop.
 */
export class PitchFrames {
  /** Samples between frames (a multiple of the decimation factor). */
  readonly hop: number;
  readonly frames: number;
  private readonly decimation: number;
  private readonly yin: Yin;
  private decimated: Float32Array | null = null;
  private readonly f0: Float32Array;
  private readonly aperiodicity: Float32Array;
  private readonly energyDb: Float32Array;
  private readonly isComputed: Uint8Array;

  constructor(
    private readonly samples: Float32Array,
    private readonly sampleRate: number,
  ) {
    this.decimation = pitchDecimation(sampleRate, YIN_MAX_HZ);
    const rate = sampleRate / this.decimation;
    const window = Math.max(rate / YIN_MIN_HZ, rate * YIN_MIN_WINDOW_SEC);
    this.yin = new Yin(rate, YIN_MIN_HZ, YIN_MAX_HZ, window);
    this.hop = this.decimation * Math.max(1, Math.round((HOP_SEC * sampleRate) / this.decimation));
    this.frames = Math.floor((samples.length - 1) / this.hop) + 1;
    this.f0 = new Float32Array(this.frames);
    this.aperiodicity = new Float32Array(this.frames);
    this.energyDb = new Float32Array(this.frames);
    this.isComputed = new Uint8Array(this.frames);
  }

  /** The frame nearest a time (clamped to the recording). */
  frameAt(sec: number): number {
    return Math.min(this.frames - 1, Math.max(0, Math.round((sec * this.sampleRate) / this.hop)));
  }

  /** The time of a frame's center (s). */
  frameTime(frame: number): number {
    return (frame * this.hop) / this.sampleRate;
  }

  /** Median YIN periodicity of the frames whose audio starts within the first 35 ms of a sound. */
  periodicity(startSec: number, endSec: number): number {
    const span = (this.yin.span * this.decimation) / this.sampleRate;
    const from = this.frameAt(startSec + this.lead);
    const reach = PERIODICITY_SPAN_SEC;
    const to = Math.max(
      from,
      this.frameAt(startSec + this.lead + Math.min(reach, Math.max(0, endSec - startSec - span))),
    );
    this.ensureComputed(from, to);
    const values: number[] = [];
    for (let i = from; i <= to; i++) values.push(1 - (this.aperiodicity[i] as number));
    return Math.max(0, Math.min(1, median(values)));
  }

  /** The sound just before `sec`: median f0 of its voiced frames (0 if unvoiced) and median periodicity. */
  soundBefore(sec: number): SoundBefore {
    const from = this.frameAt(sec - BEFORE_FROM_SEC);
    const to = this.frameAt(sec - BEFORE_TO_SEC);
    this.ensureComputed(from, to);
    const voicedHz: number[] = [];
    const periodicities: number[] = [];
    for (let i = from; i <= to; i++) {
      if ((this.f0[i] as number) > 0) voicedHz.push(this.f0[i] as number);
      periodicities.push(1 - (this.aperiodicity[i] as number));
    }
    return { f0: voicedHz.length >= 2 ? median(voicedHz) : 0, periodicity: median(periodicities) };
  }

  /**
   * MIDI pitch of the frames inside [startSec, endSec): NaN unless the frame is confidently pitched
   * and within range of the sound's `peak` level.
   */
  midiTrack(startSec: number, endSec: number, peak: number): MidiTrack {
    const from = this.frameAt(startSec + this.lead);
    const to = Math.max(from, this.frameAt(endSec - PITCH_TAIL_MARGIN_SEC));
    this.ensureComputed(from, to);
    const floorDb = ampToDb(peak) - T.pitchRangeDb;
    const midi = new Float64Array(to - from + 1);
    for (let i = from; i <= to; i++) {
      const isConfident =
        (this.f0[i] as number) > 0 &&
        1 - (this.aperiodicity[i] as number) >= T.pitchConfidence &&
        (this.energyDb[i] as number) >= floorDb;
      midi[i - from] = isConfident ? hzToMidi(this.f0[i] as number) : NaN;
    }
    return { from, midi };
  }

  /** Seconds between a pitch frame's center and the start of the audio it reads. */
  private get lead(): number {
    return (this.yin.lead * this.decimation) / this.sampleRate;
  }

  /** Runs YIN on the frames in [from, to] that have not been computed yet. */
  private ensureComputed(from: number, to: number): void {
    const yin = this.yin;
    this.decimated ??= decimate(this.samples, this.decimation, this.sampleRate);
    const decimated = this.decimated;
    const frameStep = this.hop / this.decimation;
    for (let i = Math.max(0, from); i <= Math.min(this.frames - 1, to); i++) {
      if (this.isComputed[i]) continue;
      yin.estimate(decimated, i * frameStep - yin.lead, YIN_ENERGY_FLOOR);
      this.f0[i] = yin.f0;
      this.aperiodicity[i] = yin.aperiodicity;
      this.energyDb[i] = 10 * Math.log10(Math.max(yin.energy, 1e-24));
      this.isComputed[i] = 1;
    }
  }
}
