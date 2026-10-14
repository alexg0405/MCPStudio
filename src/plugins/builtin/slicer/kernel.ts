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

const VOICES = 16;
const MAX_EVENTS = 128;
const EV_ON = 1;
const EV_OFF = 2;
const EV_ALL_OFF = 3;
const EV_ALL_OFF_HARD = 4;
/** Fades: a cut slice, and the last moments of every slice (no clicks at its end). */
const CUT_SECONDS = 0.004;
const END_SECONDS = 0.002;

class SliceVoice {
  readonly reader = new SampleReader();
  noteId = -1;
  gl = 0;
  gr = 0;
  env = 0;
  attackStep = 1;
  releaseStep = 0;
  fade = 1;
  fadeStep = 0;
  /** Output frames left before the slice ends. */
  left = 0;
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
  private readonly voices = Array.from({ length: VOICES }, () => new SliceVoice());
  private sample: Float32Array[] | null = null;
  private demo: Float32Array[] | null = null;
  private demoRate = 48000;
  /** The audio being sliced (the sample, else the demo), its rate and its overview. */
  private source: Float32Array[] | null = null;
  private sourceRate = 48000;
  private peaks: Float32Array = new Float32Array(2);
  private buckets = 0;
  private scratch = new Float64Array(1);
  private readonly starts = new Int32Array(MAX_SLICES);
  private count = 0;
  private settingsKey = NaN;
  private readonly events = new Float64Array(MAX_EVENTS * 4);
  private eventCount = 0;
  private clock = 0;
  private readonly cutStep: number;

  constructor(host: KernelHost) {
    super(host);
    this.cutStep = 1 / (CUT_SECONDS * host.sampleRate);
  }

  /** How many slices the current audio has (for tests and tools). */
  get slices(): number {
    return this.count;
  }

  /** Start frame of a slice in the current audio. */
  sliceStart(i: number): number {
    return this.starts[i] ?? 0;
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
    this.scratch = new Float64Array(this.buckets);
    this.settingsKey = NaN;
    // Slices are about to move: fade out what plays.
    for (let v = 0; v < VOICES; v++) this.cut(this.voices[v] as SliceVoice);
  }

  noteOn(key: number, velocity: number, noteId: number, _pan: number, _fine = 0): void {
    this.push(EV_ON, noteId, key, velocity);
  }

  noteOff(noteId: number, key: number, _release: number): void {
    this.push(EV_OFF, noteId, key, 0);
  }

  override allNotesOff(hard: boolean): void {
    this.push(hard ? EV_ALL_OFF_HARD : EV_ALL_OFF, 0, 0, 0);
  }

  override reset(): void {
    this.eventCount = 0;
    for (let v = 0; v < VOICES; v++) (this.voices[v] as SliceVoice).reader.stop();
  }

  private push(type: number, id: number, key: number, vel: number): void {
    if (this.eventCount >= MAX_EVENTS) return;
    const o = this.eventCount++ * 4;
    this.events[o] = type;
    this.events[o + 1] = id;
    this.events[o + 2] = key;
    this.events[o + 3] = vel;
  }

  render(out: Float32Array[], from: number, to: number, p: ParamBlock<SlicerParams>): void {
    this.updateSlices(p, from);
    if (this.eventCount > 0) this.handleEvents(p, from);
    const L = out[0] as Float32Array;
    const R = (out[1] ?? out[0]) as Float32Array;
    const level = dbToGain(at(p.level, from));
    for (let vi = 0; vi < VOICES; vi++) {
      const v = this.voices[vi] as SliceVoice;
      const reader = v.reader;
      if (!reader.active) continue;
      const gl = v.gl * level;
      const gr = v.gr * level;
      const endFrames = END_SECONDS * this.sampleRate;
      for (let i = from; i < to; i++) {
        if (!reader.next()) break;
        let env = v.env;
        if (v.releaseStep > 0) {
          env -= v.releaseStep;
          if (env <= 0) {
            reader.stop();
            break;
          }
        } else if (env < 1) env = Math.min(1, env + v.attackStep);
        v.env = env;
        if (v.fadeStep > 0) {
          v.fade -= v.fadeStep;
          if (v.fade <= 0) {
            reader.stop();
            break;
          }
        }
        v.left--;
        const tail = v.left < endFrames ? Math.max(0, v.left / endFrames) : 1;
        const g = env * v.fade * tail;
        L[i] = (L[i] as number) + reader.l * g * gl;
        R[i] = (R[i] as number) + reader.r * g * gr;
      }
    }
  }

  /** Recomputes the slices when the audio or a slicing setting changed. */
  private updateSlices(p: ParamBlock<SlicerParams>, i: number): void {
    const source = this.source;
    if (!source) {
      this.count = 0;
      return;
    }
    const mode = Math.round(at(p.mode, i));
    const sensitivity = at(p.sensitivity, i);
    const grid = Math.round(at(p.gridSlices, i));
    const minSlice = at(p.minSlice, i);
    const key = mode * 1e9 + Math.round(sensitivity * 1000) * 1e5 + grid * 1e3 + Math.round(minSlice);
    if (key === this.settingsKey) return;
    this.settingsKey = key;
    const length = (source[0] as Float32Array).length;
    this.count = computeSlices(
      this.peaks,
      this.buckets,
      length,
      this.sourceRate,
      { mode, sensitivity, gridSlices: grid, minSlice },
      this.starts,
      this.scratch,
    );
  }

  private handleEvents(p: ParamBlock<SlicerParams>, i: number): void {
    const gated = Math.round(at(p.playback, i)) === 1;
    const e = this.events;
    for (let n = 0; n < this.eventCount; n++) {
      const o = n * 4;
      const type = e[o] as number;
      if (type === EV_ON) this.start(e[o + 1] as number, e[o + 2] as number, e[o + 3] as number, p, i);
      else if (type === EV_OFF) {
        if (gated) this.release(e[o + 1] as number, p, i);
      } else
        for (let v = 0; v < VOICES; v++) {
          const voice = this.voices[v] as SliceVoice;
          if (type === EV_ALL_OFF_HARD) voice.reader.stop();
          else if (gated) this.release(voice.noteId, p, i);
        }
    }
    this.eventCount = 0;
  }

  private start(noteId: number, key: number, velocity: number, p: ParamBlock<SlicerParams>, i: number): void {
    const slice = key - FIRST_KEY;
    const source = this.source;
    if (!source || slice < 0 || slice >= this.count) return;
    if (at(p.cut, i) >= 0.5) for (let v = 0; v < VOICES; v++) this.cut(this.voices[v] as SliceVoice);
    const length = (source[0] as Float32Array).length;
    const start = this.starts[slice] as number;
    const end = slice + 1 < this.count ? (this.starts[slice + 1] as number) : length;
    const speed = (this.sourceRate / this.sampleRate) * Math.pow(2, at(p.tune, i) / 12);
    const voice = this.pick();
    voice.reader.play(source, start, end, speed, at(p.reverse, i) >= 0.5);
    voice.noteId = noteId;
    voice.left = (end - start) / speed;
    const attack = Math.max(0.0005, at(p.attack, i) / 1000);
    voice.env = 0;
    voice.attackStep = 1 / (attack * this.sampleRate);
    voice.releaseStep = 0;
    voice.fade = 1;
    voice.fadeStep = 0;
    voice.age = ++this.clock;
    const sens = at(p.velocity, i);
    const gain = 1 - sens + sens * velocity;
    voice.gl = gain;
    voice.gr = gain;
  }

  private release(noteId: number, p: ParamBlock<SlicerParams>, i: number): void {
    for (let v = 0; v < VOICES; v++) {
      const voice = this.voices[v] as SliceVoice;
      if (!voice.reader.active || voice.noteId !== noteId || voice.releaseStep > 0) continue;
      voice.releaseStep = Math.max(voice.env, 1e-3) / ((at(p.release, i) / 1000) * this.sampleRate);
    }
  }

  private cut(voice: SliceVoice): void {
    if (voice.reader.active && voice.fadeStep === 0) voice.fadeStep = this.cutStep;
  }

  /** A free voice, else the oldest. */
  private pick(): SliceVoice {
    let pick = this.voices[0] as SliceVoice;
    for (let v = 0; v < VOICES; v++) {
      const voice = this.voices[v] as SliceVoice;
      if (!voice.reader.active) return voice;
      if (voice.age < pick.age) pick = voice;
    }
    return pick;
  }
}
