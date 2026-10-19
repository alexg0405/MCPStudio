import {
  at,
  dbToGain,
  InstrumentKernel,
  OVERVIEW_BUCKET,
  peakOverview,
  SampleReader,
  type KernelHost,
  type ParamBlock,
} from '@agstudio/sdk/worklet';
import { FIRST_KEY, MAX_SLICES, type SlicerParams } from './params';
import { computeSlices } from './slices.kernel';

const VOICE_COUNT = 16;
const MAX_EVENTS = 128;
const EVENT_NOTE_ON = 1;
const EVENT_NOTE_OFF = 2;
const EVENT_ALL_OFF = 3;
const EVENT_ALL_OFF_HARD = 4;
/** Fades: a cut slice, and the last moments of every slice (no clicks at its end). */
const CUT_FADE_SEC = 0.004;
const END_FADE_SEC = 0.002;

class SliceVoice {
  readonly reader = new SampleReader();
  noteId = -1;
  gainLeft = 0;
  gainRight = 0;
  envelope = 0;
  attackStep = 1;
  releaseStep = 0;
  cutFade = 1;
  cutFadeStep = 0;
  /** Output frames left before the slice ends. */
  framesLeft = 0;
  age = 0;
}

/** The demo loop from the main thread: `{ type: 'demo', data, sampleRate }`. */
export interface DemoMessage {
  type: 'demo';
  data: Float32Array;
  sampleRate: number;
}

/**
 * Slicex-style slicer: cuts its sample (or the built-in demo loop while the slot is empty) into
 * slices at hits or on an even grid, and plays slice n on key 60 + n. One-shot or gated playback,
 * cut (a new slice stops the last), tune by resampling, reverse, attack and release. The slices
 * come from the same peak overview the editor draws, so the markers match what plays.
 */
export class SlicerKernel extends InstrumentKernel<SlicerParams> {
  private readonly voices = Array.from({ length: VOICE_COUNT }, () => new SliceVoice());
  private sample: Float32Array[] | null = null;
  private demo: Float32Array[] | null = null;
  private demoRate = 48000;
  /** The audio being sliced (the sample, else the demo), its rate and its overview. */
  private source: Float32Array[] | null = null;
  private sourceRate = 48000;
  private peaks: Float32Array = new Float32Array(2);
  private buckets = 0;
  private sliceScratch = new Float64Array(1);
  private readonly sliceStarts = new Int32Array(MAX_SLICES);
  private sliceCount = 0;
  private slicingKey = NaN;
  private readonly events = new Float64Array(MAX_EVENTS * 4);
  private eventCount = 0;
  private noteClock = 0;
  private readonly cutFadePerFrame: number;

  constructor(host: KernelHost) {
    super(host);
    this.cutFadePerFrame = 1 / (CUT_FADE_SEC * host.sampleRate);
  }

  /** How many slices the current audio has (for tests and tools). */
  get slices(): number {
    return this.sliceCount;
  }

  /** Start frame of a slice in the current audio. */
  sliceStart(slice: number): number {
    return this.sliceStarts[slice] ?? 0;
  }

  override onMessage(msg: unknown): void {
    const m = msg as Partial<DemoMessage> | null;
    if (m?.type !== 'demo' || !(m.data instanceof Float32Array)) return;
    this.demo = [m.data];
    this.demoRate = m.sampleRate ?? 48000;
    if (!this.sample) this.use(this.demo, this.demoRate);
  }

  override onSample(slot: string, channels: Float32Array[] | null, sampleRate: number): void {
    if (slot !== 'main') return;
    this.sample = channels && channels.length > 0 && (channels[0]?.length ?? 0) > 0 ? channels : null;
    if (this.sample) this.use(this.sample, sampleRate);
    else if (this.demo) this.use(this.demo, this.demoRate);
    else this.source = null;
  }

  /** Switches to new audio: its overview, and slices recomputed at the next render. */
  private use(channels: Float32Array[], rate: number): void {
    this.source = channels;
    this.sourceRate = rate;
    this.peaks = peakOverview(channels, OVERVIEW_BUCKET);
    this.buckets = this.peaks.length >> 1;
    this.sliceScratch = new Float64Array(this.buckets);
    this.slicingKey = NaN;
    // Slices are about to move: fade out what plays.
    for (let voiceIndex = 0; voiceIndex < VOICE_COUNT; voiceIndex++) this.cut(this.voices[voiceIndex] as SliceVoice);
  }

  noteOn(key: number, velocity: number, noteId: number, _pan: number, _fine = 0): void {
    this.push(EVENT_NOTE_ON, noteId, key, velocity);
  }

  noteOff(noteId: number, key: number, _release: number): void {
    this.push(EVENT_NOTE_OFF, noteId, key, 0);
  }

  override allNotesOff(hard: boolean): void {
    this.push(hard ? EVENT_ALL_OFF_HARD : EVENT_ALL_OFF, 0, 0, 0);
  }

  override reset(): void {
    this.eventCount = 0;
    for (let voiceIndex = 0; voiceIndex < VOICE_COUNT; voiceIndex++)
      (this.voices[voiceIndex] as SliceVoice).reader.stop();
  }

  private push(type: number, id: number, key: number, velocity: number): void {
    if (this.eventCount >= MAX_EVENTS) return;
    const offset = this.eventCount++ * 4;
    this.events[offset] = type;
    this.events[offset + 1] = id;
    this.events[offset + 2] = key;
    this.events[offset + 3] = velocity;
  }

  render(out: Float32Array[], from: number, to: number, params: ParamBlock<SlicerParams>): void {
    this.updateSlices(params, from);
    if (this.eventCount > 0) this.handleEvents(params, from);
    const left = out[0] as Float32Array;
    const right = (out[1] ?? out[0]) as Float32Array;
    const level = dbToGain(at(params.level, from));
    for (let voiceIndex = 0; voiceIndex < VOICE_COUNT; voiceIndex++) {
      const voice = this.voices[voiceIndex] as SliceVoice;
      const reader = voice.reader;
      if (!reader.active) continue;
      const leftGain = voice.gainLeft * level;
      const rightGain = voice.gainRight * level;
      const endFadeFrames = END_FADE_SEC * this.sampleRate;
      for (let i = from; i < to; i++) {
        if (!reader.next()) break;
        let envelopeNow = voice.envelope;
        if (voice.releaseStep > 0) {
          envelopeNow -= voice.releaseStep;
          if (envelopeNow <= 0) {
            reader.stop();
            break;
          }
        } else if (envelopeNow < 1) envelopeNow = Math.min(1, envelopeNow + voice.attackStep);
        voice.envelope = envelopeNow;
        if (voice.cutFadeStep > 0) {
          voice.cutFade -= voice.cutFadeStep;
          if (voice.cutFade <= 0) {
            reader.stop();
            break;
          }
        }
        voice.framesLeft--;
        const endFade = voice.framesLeft < endFadeFrames ? Math.max(0, voice.framesLeft / endFadeFrames) : 1;
        const gain = envelopeNow * voice.cutFade * endFade;
        left[i] = (left[i] as number) + reader.l * gain * leftGain;
        right[i] = (right[i] as number) + reader.r * gain * rightGain;
      }
    }
  }

  /** Recomputes the slices when the audio or a slicing setting changed. */
  private updateSlices(params: ParamBlock<SlicerParams>, frame: number): void {
    const source = this.source;
    if (!source) {
      this.sliceCount = 0;
      return;
    }
    const mode = Math.round(at(params.mode, frame));
    const sensitivity = at(params.sensitivity, frame);
    const grid = Math.round(at(params.gridSlices, frame));
    const minSlice = at(params.minSlice, frame);
    const key = mode * 1e9 + Math.round(sensitivity * 1000) * 1e5 + grid * 1e3 + Math.round(minSlice);
    if (key === this.slicingKey) return;
    this.slicingKey = key;
    const length = (source[0] as Float32Array).length;
    this.sliceCount = computeSlices(
      this.peaks,
      this.buckets,
      length,
      this.sourceRate,
      { mode, sensitivity, gridSlices: grid, minSlice },
      this.sliceStarts,
      this.sliceScratch,
    );
  }

  private handleEvents(params: ParamBlock<SlicerParams>, frame: number): void {
    const isGated = Math.round(at(params.playback, frame)) === 1;
    const events = this.events;
    for (let eventIndex = 0; eventIndex < this.eventCount; eventIndex++) {
      const offset = eventIndex * 4;
      const type = events[offset] as number;
      if (type === EVENT_NOTE_ON)
        this.start(
          events[offset + 1] as number,
          events[offset + 2] as number,
          events[offset + 3] as number,
          params,
          frame,
        );
      else if (type === EVENT_NOTE_OFF) {
        if (isGated) this.release(events[offset + 1] as number, params, frame);
      } else
        for (let voiceIndex = 0; voiceIndex < VOICE_COUNT; voiceIndex++) {
          const voice = this.voices[voiceIndex] as SliceVoice;
          if (type === EVENT_ALL_OFF_HARD) voice.reader.stop();
          else if (isGated) this.release(voice.noteId, params, frame);
        }
    }
    this.eventCount = 0;
  }

  private start(noteId: number, key: number, velocity: number, params: ParamBlock<SlicerParams>, frame: number): void {
    const slice = key - FIRST_KEY;
    const source = this.source;
    if (!source || slice < 0 || slice >= this.sliceCount) return;
    if (at(params.cut, frame) >= 0.5)
      for (let voiceIndex = 0; voiceIndex < VOICE_COUNT; voiceIndex++) this.cut(this.voices[voiceIndex] as SliceVoice);
    const length = (source[0] as Float32Array).length;
    const start = this.sliceStarts[slice] as number;
    const end = slice + 1 < this.sliceCount ? (this.sliceStarts[slice + 1] as number) : length;
    const speed = (this.sourceRate / this.sampleRate) * Math.pow(2, at(params.tune, frame) / 12);
    const voice = this.pickVoice();
    voice.reader.play(source, start, end, speed, at(params.reverse, frame) >= 0.5);
    voice.noteId = noteId;
    voice.framesLeft = (end - start) / speed;
    const attack = Math.max(0.0005, at(params.attack, frame) / 1000);
    voice.envelope = 0;
    voice.attackStep = 1 / (attack * this.sampleRate);
    voice.releaseStep = 0;
    voice.cutFade = 1;
    voice.cutFadeStep = 0;
    voice.age = ++this.noteClock;
    const velocitySensitivity = at(params.velocity, frame);
    const gain = 1 - velocitySensitivity + velocitySensitivity * velocity;
    voice.gainLeft = gain;
    voice.gainRight = gain;
  }

  private release(noteId: number, params: ParamBlock<SlicerParams>, frame: number): void {
    for (let voiceIndex = 0; voiceIndex < VOICE_COUNT; voiceIndex++) {
      const voice = this.voices[voiceIndex] as SliceVoice;
      if (!voice.reader.active || voice.noteId !== noteId || voice.releaseStep > 0) continue;
      voice.releaseStep = Math.max(voice.envelope, 1e-3) / ((at(params.release, frame) / 1000) * this.sampleRate);
    }
  }

  private cut(voice: SliceVoice): void {
    if (voice.reader.active && voice.cutFadeStep === 0) voice.cutFadeStep = this.cutFadePerFrame;
  }

  /** A free voice, else the oldest. */
  private pickVoice(): SliceVoice {
    let oldest = this.voices[0] as SliceVoice;
    for (let voiceIndex = 0; voiceIndex < VOICE_COUNT; voiceIndex++) {
      const voice = this.voices[voiceIndex] as SliceVoice;
      if (!voice.reader.active) return voice;
      if (voice.age < oldest.age) oldest = voice;
    }
    return oldest;
  }
}
