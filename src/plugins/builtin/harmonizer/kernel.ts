import {
  at,
  dbToGain,
  EffectKernel,
  ftom,
  Readings,
  Yin,
  type KernelHost,
  type ParamBlock,
} from '@agstudio/sdk/worklet';
import {
  foldNearPitch,
  heldKeyAbove,
  heldKeyBelow,
  limitShift,
  nearestHeldKey,
  nearestScaleNote,
  scaleMaskOf,
  scaleStepSemitones,
} from './harmony.kernel';
import {
  harmonizerLatencyFrames,
  HARMONIZER_SCALES,
  MAX_VOICES,
  RANGE_HZ,
  RANGES,
  type harmonizerParams,
} from './params';
import { SampleRing } from './ring.kernel';
import { HarmonyVoice } from './voice.kernel';

type Params = typeof harmonizerParams;

/** A new pitch estimate (and new notes for the voices) every HOP_FRAMES frames. */
const HOP_FRAMES = 256;
/** Detections less sure than this count as unvoiced. */
const MIN_CONFIDENCE = 0.6;
/** How much of a new pitch estimate the smoothed pitch takes (per hop); a jump beyond JUMP_SEMITONES is taken whole. */
const PITCH_SMOOTHING = 0.3;
const PITCH_JUMP_SEMITONES = 0.7;
/** After this many detections in a row with no pitch (≈ 43 ms) the next pitch found starts a fresh note. */
const UNPITCHED_HOPS_TO_FORGET = 8;
/** The lowest pitch the detector looks for, Hz (sizes the delay line: a period of it must fit). */
const LOWEST_PITCH_HZ = 50;
/** Played notes the kernel keeps track of at once (a chord of more is rare; the oldest goes). */
const MAX_HELD = 16;
/** Each voice's slow drift is two sine waves: the first runs between these rates (Hz), the second 1.9 times as fast. */
const DRIFT_SLOWEST_HZ = 0.35;
const DRIFT_FASTEST_HZ = 0.85;
const DRIFT_SECOND_WAVE_RATIO = 1.9;
const DRIFT_SECOND_WAVE_SHARE = 0.5;
const TWO_PI = Math.PI * 2;

/** The scales' intervals and pitch-class masks, by the order of the Scale param's options. */
const SCALE_INTERVALS = HARMONIZER_SCALES.map((scale) => scale.intervals as readonly number[]);
const SCALE_MASKS = SCALE_INTERVALS.map(scaleMaskOf);

/**
 * Real-time vocal harmonizer: up to three pitch-shifted copies of a voice that sing along in the key, or on the
 * notes a guide instrument holds. YIN (SDK) finds the sung pitch every 256 frames. In Key and scale mode the
 * sung pitch is matched to the nearest note of the scale, and each voice moves that many scale steps up or down
 * (plus its fixed shift); the voice keeps the singer's own slides and vibrato because it stays an interval away
 * from the live pitch. In Played notes mode each voice goes to an absolute held note. Each voice is a
 * `HarmonyVoice` reading one shared mono delay line; the dry signal is read from its own lines at the same
 * delay, so with Mix at 0 the output is the input delayed by exactly the reported latency.
 */
export class HarmonizerKernel extends EffectKernel<Params> {
  readonly latency = harmonizerLatencyFrames(this.sampleRate);
  private readonly dryLeftLine = new SampleRing(this.latency + 8);
  private readonly dryRightLine = new SampleRing(this.latency + 8);
  /** The mono sum every voice reads: it must hold the resting delay, a splice's reach and a period of the lowest pitch. */
  private readonly voiceLine = new SampleRing(2 * this.latency + 2 * Math.ceil(this.sampleRate / LOWEST_PITCH_HZ) + 64);
  private readonly detectors: Yin[];
  private readonly voices: HarmonyVoice[] = [];
  private readonly meter = new Readings(this.host, ['pitch', 'target'] as const);
  private rangeIndex = -1;
  private framesSinceDetection = 0;

  // ---- What the singer is doing ----
  /** The sung pitch, smoothed, as a fractional MIDI note (NaN until a pitch has been heard). */
  private smoothedPitchMidi = Number.NaN;
  private needsFreshPitch = true;
  private unpitchedHops = 0;
  /** The scale note the sung pitch is matched to (-1: none), and the held note voice 1 follows (-1: none). */
  private inputNote = -1;
  private guideKey = -1;

  // ---- Settings read from the params once per block ----
  private voiceCount = 2;
  private readonly scaleSteps = new Int8Array(MAX_VOICES);
  private readonly fixedSemitones = new Int8Array(MAX_VOICES);
  private readonly voiceGain = new Float64Array(MAX_VOICES);
  private readonly voicePan = new Float64Array(MAX_VOICES);
  private rootPitchClass = 0;
  private scaleIndex = 0;
  private followsNotes = false;
  private humanizeCents = 0;
  private snapToKey = 0;

  // ---- Humanize: each voice drifts on two slow sine waves (phases in cycles, seeded once) ----
  private readonly driftPhaseA = new Float64Array(MAX_VOICES);
  private readonly driftPhaseB = new Float64Array(MAX_VOICES);
  private readonly driftStepA = new Float64Array(MAX_VOICES);
  private readonly driftStepB = new Float64Array(MAX_VOICES);

  // ---- Played notes (Target = notes) ----
  private readonly heldKeys = new Int16Array(MAX_HELD);
  private readonly heldIds = new Int32Array(MAX_HELD);
  private heldCount = 0;

  constructor(host: KernelHost) {
    super(host);
    this.detectors = RANGES.map((range) => {
      const [minHz, maxHz] = RANGE_HZ[range];
      return new Yin(this.sampleRate, { minHz, maxHz });
    });
    for (let voice = 0; voice < MAX_VOICES; voice++) {
      this.voices.push(new HarmonyVoice(this.sampleRate, this.latency));
      this.seedDrift(voice);
    }
    this.meter.values.pitch = 0;
    this.meter.values.target = -1;
  }

  /** Gives voice `voice` its own drift waves, from the host's seeded random numbers (the same every run). */
  private seedDrift(voice: number): void {
    const hopsPerSecond = this.sampleRate / HOP_FRAMES;
    const rateHz = DRIFT_SLOWEST_HZ + this.host.rand() * (DRIFT_FASTEST_HZ - DRIFT_SLOWEST_HZ);
    this.driftStepA[voice] = rateHz / hopsPerSecond;
    this.driftStepB[voice] = (rateHz * DRIFT_SECOND_WAVE_RATIO) / hopsPerSecond;
    this.driftPhaseA[voice] = this.host.rand();
    this.driftPhaseB[voice] = this.host.rand();
  }

  override reset(): void {
    this.dryLeftLine.clear();
    this.dryRightLine.clear();
    this.voiceLine.clear();
    for (const detector of this.detectors) detector.reset();
    for (let voice = 0; voice < MAX_VOICES; voice++) (this.voices[voice] as HarmonyVoice).reset();
    this.smoothedPitchMidi = Number.NaN;
    this.needsFreshPitch = true;
    this.unpitchedHops = 0;
    this.inputNote = -1;
    this.guideKey = -1;
    this.heldCount = 0;
  }

  // ---- Played notes ----

  override noteOn(key: number, _velocity: number, noteId: number): void {
    for (let i = 0; i < this.heldCount; i++) {
      if (this.heldIds[i] === noteId) {
        this.heldKeys[i] = key;
        return;
      }
    }
    if (this.heldCount === MAX_HELD) {
      // The oldest goes.
      this.heldKeys.copyWithin(0, 1);
      this.heldIds.copyWithin(0, 1);
      this.heldCount--;
    }
    this.heldKeys[this.heldCount] = key;
    this.heldIds[this.heldCount] = noteId;
    this.heldCount++;
  }

  override noteOff(noteId: number): void {
    for (let i = 0; i < this.heldCount; i++) {
      if (this.heldIds[i] !== noteId) continue;
      this.heldKeys.copyWithin(i, i + 1, this.heldCount);
      this.heldIds.copyWithin(i, i + 1, this.heldCount);
      this.heldCount--;
      return;
    }
  }

  override allNotesOff(): void {
    this.heldCount = 0;
  }

  process(input: Float32Array[], output: Float32Array[], frameCount: number, params: ParamBlock<Params>): void {
    const inLeft = input[0] as Float32Array;
    const inRight = (input[1] ?? inLeft) as Float32Array;
    const outLeft = output[0] as Float32Array;
    const outRight = (output[1] ?? outLeft) as Float32Array;
    const rangeIndex = Math.round(params.range[0] as number);
    if (rangeIndex !== this.rangeIndex) {
      this.rangeIndex = rangeIndex;
      this.detectors[rangeIndex]?.reset();
      this.inputNote = -1;
    }
    const detector = (this.detectors[rangeIndex] ?? this.detectors[1]) as Yin;
    this.readBlockSettings(params);
    const keepsFormants = (params.formant[0] as number) > 0.5;
    const leftLine = this.dryLeftLine;
    const rightLine = this.dryRightLine;
    for (let i = 0; i < frameCount; i++) {
      const inputLeft = inLeft[i] as number;
      const inputRight = inRight[i] as number;
      const monoInput = 0.5 * (inputLeft + inputRight);
      this.listen(detector, monoInput);
      leftLine.write(inputLeft);
      rightLine.write(inputRight);
      this.voiceLine.write(monoInput);
      let wetLeft = 0;
      let wetRight = 0;
      for (let voiceIndex = 0; voiceIndex < MAX_VOICES; voiceIndex++) {
        const voice = this.voices[voiceIndex] as HarmonyVoice;
        voice.render(this.voiceLine, keepsFormants);
        wetLeft += voice.left;
        wetRight += voice.right;
      }
      // Mix: the original stays at full level up to 50 %, and the voices are at full level from there on.
      const mix = at(params.mix, i);
      const dryShare = Math.min(1, 2 * (1 - mix));
      const wetShare = Math.min(1, 2 * mix);
      outLeft[i] = dryShare * leftLine.at(this.latency) + wetShare * wetLeft;
      outRight[i] = dryShare * rightLine.at(this.latency) + wetShare * wetRight;
    }
    this.meter.tick(frameCount);
  }

  /** Feeds the detector one frame; every HOP_FRAMES frames it gives a new pitch estimate and the voices new notes. */
  private listen(detector: Yin, monoInput: number): void {
    detector.push(monoInput);
    if (++this.framesSinceDetection < HOP_FRAMES) return;
    this.framesSinceDetection = 0;
    this.retarget(detector);
  }

  /** Reads the params that are used once per block (not per frame) and gives the voices their level and pan. */
  private readBlockSettings(params: ParamBlock<Params>): void {
    this.voiceCount = Math.round(params.voices[0] as number);
    this.followsNotes = Math.round(params.source[0] as number) === 1;
    this.rootPitchClass = Math.round(params.key[0] as number);
    this.scaleIndex = Math.round(params.scale[0] as number);
    this.humanizeCents = params.humanize[0] as number;
    this.snapToKey = params.tighten[0] as number;
    this.readVoice(0, params.interval1, params.semitones1, params.level1, params.pan1);
    this.readVoice(1, params.interval2, params.semitones2, params.level2, params.pan2);
    this.readVoice(2, params.interval3, params.semitones3, params.level3, params.pan3);
    const hasHarmony = !this.followsNotes || this.heldCount > 0;
    for (let voice = 0; voice < MAX_VOICES; voice++) {
      const isOn = hasHarmony && voice < this.voiceCount;
      const gain = isOn ? (this.voiceGain[voice] as number) : 0;
      // Equal-power pan: the voice keeps its loudness as it moves across.
      const angle = ((this.voicePan[voice] as number) + 1) * (Math.PI / 4);
      (this.voices[voice] as HarmonyVoice).setTargetGains(gain * Math.cos(angle), gain * Math.sin(angle));
    }
  }

  private readVoice(voice: number, steps: Float32Array, semitones: Float32Array, levelDb: Float32Array, pan: Float32Array): void {
    this.scaleSteps[voice] = steps[0] as number;
    this.fixedSemitones[voice] = semitones[0] as number;
    this.voiceGain[voice] = dbToGain(levelDb[0] as number);
    this.voicePan[voice] = pan[0] as number;
  }

  /** A new pitch estimate: keep the smoothed pitch, tell the voices about it and pick the notes they sing. */
  private retarget(detector: Yin): void {
    const pitchHz = detector.detect();
    const readings = this.meter.values;
    const isVoiced = pitchHz > 0 && detector.confidence >= MIN_CONFIDENCE;
    this.advanceDrift();
    if (!isVoiced) {
      this.noteUnpitched();
      readings.pitch = 0;
      this.pickNotes();
      return;
    }
    this.unpitchedHops = 0;
    const periodFrames = this.sampleRate / pitchHz;
    this.tellVoicesPitch(periodFrames, true);
    this.smoothPitch(ftom(pitchHz));
    readings.pitch = pitchHz;
    this.pickNotes();
  }

  /** No pitch this time: the voices go on with what they have, and a long enough pause makes the next pitch a fresh start. */
  private noteUnpitched(): void {
    if (this.unpitchedHops < UNPITCHED_HOPS_TO_FORGET) this.unpitchedHops++;
    else this.needsFreshPitch = true;
    this.tellVoicesPitch(0, false);
  }

  /** Passes the detector's result on to every voice's shifter. */
  private tellVoicesPitch(periodFrames: number, isVoiced: boolean): void {
    for (let voice = 0; voice < MAX_VOICES; voice++) (this.voices[voice] as HarmonyVoice).setPitch(periodFrames, isVoiced);
  }

  /** Follows the sung pitch with a little smoothing (a new note or a restart is taken whole). */
  private smoothPitch(pitchMidi: number): void {
    const isJump = Math.abs(pitchMidi - this.smoothedPitchMidi) > PITCH_JUMP_SEMITONES;
    if (this.needsFreshPitch || Number.isNaN(this.smoothedPitchMidi) || isJump) this.smoothedPitchMidi = pitchMidi;
    else this.smoothedPitchMidi += (pitchMidi - this.smoothedPitchMidi) * PITCH_SMOOTHING;
    this.needsFreshPitch = false;
  }

  /** Moves every voice's two drift waves on by one hop. */
  private advanceDrift(): void {
    for (let voice = 0; voice < MAX_VOICES; voice++) {
      this.driftPhaseA[voice] = ((this.driftPhaseA[voice] as number) + (this.driftStepA[voice] as number)) % 1;
      this.driftPhaseB[voice] = ((this.driftPhaseB[voice] as number) + (this.driftStepB[voice] as number)) % 1;
    }
  }

  /** The drift of one voice, cents: the two waves added, scaled so the largest swing is `humanizeCents`. */
  private driftOf(voice: number): number {
    const waves =
      Math.sin(TWO_PI * (this.driftPhaseA[voice] as number)) +
      DRIFT_SECOND_WAVE_SHARE * Math.sin(TWO_PI * (this.driftPhaseB[voice] as number));
    return (this.humanizeCents * waves) / (1 + DRIFT_SECOND_WAVE_SHARE);
  }

  /** Works out the shift each voice should sing, from the sung pitch and the key or the held notes. */
  private pickNotes(): void {
    if (Number.isNaN(this.smoothedPitchMidi)) return;
    if (this.followsNotes) this.pickGuideNotes();
    else this.pickScaleNotes();
  }

  /** Key and scale: each voice sits its scale steps (plus fixed shift) from the scale note nearest the singer. */
  private pickScaleNotes(): void {
    const intervals = (SCALE_INTERVALS[this.scaleIndex] ?? SCALE_INTERVALS[0]) as readonly number[];
    const mask = SCALE_MASKS[this.scaleIndex] ?? SCALE_MASKS[0] ?? 0xfff;
    this.inputNote = nearestScaleNote(this.smoothedPitchMidi, this.rootPitchClass, mask, this.inputNote);
    // Snapping moves every voice by the singer's distance from that note, so each lands exactly on a scale note.
    const snapCents = this.snapToKey * 100 * (this.inputNote - this.smoothedPitchMidi);
    for (let voice = 0; voice < MAX_VOICES; voice++) {
      const steps = this.scaleSteps[voice] as number;
      const shift = scaleStepSemitones(this.inputNote, this.rootPitchClass, intervals, steps) + (this.fixedSemitones[voice] as number);
      const limited = limitShift(shift);
      (this.voices[voice] as HarmonyVoice).setGoalCents(100 * limited + snapCents + this.driftOf(voice));
      if (voice === 0) this.meter.values.target = this.inputNote + limited;
    }
  }

  /** Played notes: voice 1 sings the held note nearest the singer, voice 2 the next one above it, voice 3 the next below. */
  private pickGuideNotes(): void {
    if (this.heldCount === 0) {
      this.guideKey = -1;
      this.meter.values.target = -1;
      return;
    }
    const nearest = nearestHeldKey(this.heldKeys, this.heldCount, this.smoothedPitchMidi, this.guideKey);
    this.guideKey = nearest;
    for (let voice = 0; voice < MAX_VOICES; voice++) {
      const key = this.guideKeyFor(voice, nearest);
      const note = foldNearPitch(key, this.smoothedPitchMidi);
      const shiftCents = 100 * (note - this.smoothedPitchMidi);
      (this.voices[voice] as HarmonyVoice).setGoalCents(shiftCents + this.driftOf(voice));
      if (voice === 0) this.meter.values.target = note;
    }
  }

  /** The held key voice `voice` sings, given the one nearest the singer. */
  private guideKeyFor(voice: number, nearest: number): number {
    if (voice === 1) return heldKeyAbove(this.heldKeys, this.heldCount, nearest);
    if (voice === 2) return heldKeyBelow(this.heldKeys, this.heldCount, nearest);
    return nearest;
  }
}
