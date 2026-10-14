import { at, dbToGain, InstrumentKernel, SampleReader, type KernelHost, type ParamBlock } from '@agstudio/sdk/worklet';
import { FIRST_KEY, FULL_DECAY, padParam, PAD_SLOTS, PADS, type drumPadsParams } from './params';

type Params = typeof drumPadsParams;

const MAX_VOICES = 32;
const MAX_PENDING = 64;
/** A choked hit fades out over this long. */
const CHOKE_SECONDS = 0.004;
/** −80 dB: a decaying hit is done. */
const SILENT = 1e-4;

class PadVoice {
  readonly reader = new SampleReader();
  /** Index of the pad (0 = pad 1) playing, −1 when free. */
  pad = -1;
  gl = 0;
  gr = 0;
  env = 1;
  decayCoef = 1;
  /** 1 until choked, then falling to 0. */
  fade = 1;
  fadeStep = 0;
  age = 0;
}

/** The message the main thread sends once (see index.ts): the built-in sounds at the context's rate. */
export interface SoundsMessage {
  type: 'sounds';
  sampleRate: number;
  /** One per SOUND_IDS entry (null for "Nothing"). */
  sounds: (Float32Array | null)[];
}

/**
 * 16 pads on keys 36–51. Each plays its sample slot (`pad1`…`pad16`) or, while that is empty, the
 * built-in sound its `padNSound` param picks; tuned by resampling, with its own level, pan, decay,
 * reverse and choke group. Hits are one-shots (note lengths don't matter). A hit cuts every
 * sounding voice in its choke group (earlier hits of the same pad included) with a 4 ms fade.
 */
export class DrumPadsKernel extends InstrumentKernel<Params> {
  private readonly voices = Array.from({ length: MAX_VOICES }, () => new PadVoice());
  /** Loaded samples per pad (null: use the built-in sound) and their sample rates. */
  private readonly samples: (Float32Array[] | null)[] = new Array<Float32Array[] | null>(PADS).fill(null);
  private readonly sampleRates = new Float64Array(PADS);
  /** Built-in sounds as one-channel lists, by SOUND_IDS index. */
  private sounds: Float32Array[][] = [];
  private soundRate = 48000;
  private readonly ids = Array.from({ length: PADS }, (_, i) => padParam(i + 1));
  private readonly pendPad = new Int32Array(MAX_PENDING);
  private readonly pendVel = new Float32Array(MAX_PENDING);
  private readonly pendPan = new Float32Array(MAX_PENDING);
  private pending = 0;
  private clock = 0;
  private readonly chokeStep: number;

  constructor(host: KernelHost) {
    super(host);
    this.chokeStep = 1 / (CHOKE_SECONDS * host.sampleRate);
  }

  override onMessage(msg: unknown): void {
    const m = msg as Partial<SoundsMessage> | null;
    if (m?.type !== 'sounds' || !Array.isArray(m.sounds)) return;
    this.sounds = m.sounds.map((s) => (s ? [s] : []));
    this.soundRate = m.sampleRate ?? this.sampleRate;
  }

  override onSample(slot: string, channels: Float32Array[] | null, sampleRate: number): void {
    const pad = PAD_SLOTS.indexOf(slot);
    if (pad < 0) return;
    this.samples[pad] = channels && channels.length > 0 && (channels[0]?.length ?? 0) > 0 ? channels : null;
    this.sampleRates[pad] = sampleRate;
  }

  noteOn(key: number, velocity: number, _noteId: number, pan: number, _fine = 0): void {
    const pad = key - FIRST_KEY;
    if (pad < 0 || pad >= PADS || this.pending >= MAX_PENDING) return;
    this.pendPad[this.pending] = pad;
    this.pendVel[this.pending] = velocity;
    this.pendPan[this.pending] = pan;
    this.pending++;
  }

  /** Pads are one-shots: releasing a key doesn't stop the hit. */
  noteOff(_noteId: number, _key: number, _release: number): void {}

  override allNotesOff(hard: boolean): void {
    this.pending = 0;
    if (!hard) return;
    for (let v = 0; v < MAX_VOICES; v++) this.choke(this.voices[v] as PadVoice);
  }

  override reset(): void {
    this.pending = 0;
    for (let v = 0; v < MAX_VOICES; v++) {
      const voice = this.voices[v] as PadVoice;
      voice.reader.stop();
      voice.pad = -1;
    }
  }

  render(out: Float32Array[], from: number, to: number, p: ParamBlock<Params>): void {
    if (this.pending > 0) this.startPending(p, from);
    const L = out[0] as Float32Array;
    const R = (out[1] ?? out[0]) as Float32Array;
    const master = dbToGain(at(p.level as Float32Array, from));
    for (let v = 0; v < MAX_VOICES; v++) {
      const voice = this.voices[v] as PadVoice;
      const reader = voice.reader;
      if (!reader.active) continue;
      const gl = voice.gl * master;
      const gr = voice.gr * master;
      let env = voice.env;
      let fade = voice.fade;
      const coef = voice.decayCoef;
      const step = voice.fadeStep;
      for (let i = from; i < to; i++) {
        if (!reader.next()) break;
        const g = env * fade;
        L[i] = (L[i] as number) + reader.l * g * gl;
        R[i] = (R[i] as number) + reader.r * g * gr;
        env *= coef;
        if (step > 0) {
          fade -= step;
          if (fade <= 0) {
            reader.stop();
            break;
          }
        }
        if (env < SILENT) {
          reader.stop();
          break;
        }
      }
      voice.env = env;
      voice.fade = fade;
      if (!reader.active) voice.pad = -1;
    }
  }

  private startPending(p: ParamBlock<Params>, i: number): void {
    const sens = at(p.velocity as Float32Array, i);
    for (let n = 0; n < this.pending; n++) {
      const vel = 1 - sens + sens * (this.pendVel[n] as number);
      this.start(this.pendPad[n] as number, vel, this.pendPan[n] as number, p, i);
    }
    this.pending = 0;
  }

  private param(p: ParamBlock<Params>, id: string, i: number): number {
    return at(p[id] as Float32Array, i);
  }

  private start(pad: number, vel: number, notePan: number, p: ParamBlock<Params>, i: number): void {
    const id = this.ids[pad] as ReturnType<typeof padParam>;
    const group = Math.round(this.param(p, id.choke, i));
    if (group > 0)
      for (let v = 0; v < MAX_VOICES; v++) {
        const voice = this.voices[v] as PadVoice;
        if (!voice.reader.active || voice.pad < 0) continue;
        const theirs = this.ids[voice.pad] as ReturnType<typeof padParam>;
        if (Math.round(this.param(p, theirs.choke, i)) === group) this.choke(voice);
      }

    let channels = this.samples[pad] ?? null;
    let rate = this.sampleRates[pad] as number;
    if (!channels) {
      const sound = this.sounds[Math.round(this.param(p, id.sound, i))];
      if (!sound || sound.length === 0) return;
      channels = sound;
      rate = this.soundRate;
    }
    const length = (channels[0] as Float32Array).length;
    const speed = (rate / this.sampleRate) * Math.pow(2, this.param(p, id.tune, i) / 12);
    const voice = this.pick();
    voice.reader.play(channels, 0, length, speed, this.param(p, id.reverse, i) >= 0.5);
    voice.pad = pad;
    const gain = dbToGain(this.param(p, id.level, i)) * vel;
    const pan = Math.max(-1, Math.min(1, this.param(p, id.pan, i) + notePan));
    // Balance: the centre leaves both sides at full level (as a sampler does with stereo sounds).
    voice.gl = gain * Math.min(1, 1 - pan);
    voice.gr = gain * Math.min(1, 1 + pan);
    const decay = this.param(p, id.decay, i);
    voice.decayCoef = decay >= FULL_DECAY * 0.999 ? 1 : Math.exp(-6.907755 / (decay * this.sampleRate));
    voice.env = 1;
    voice.fade = 1;
    voice.fadeStep = 0;
    voice.age = ++this.clock;
  }

  private choke(voice: PadVoice): void {
    if (voice.reader.active && voice.fadeStep === 0) voice.fadeStep = this.chokeStep;
  }

  /** A free voice, else the oldest. */
  private pick(): PadVoice {
    let pick = this.voices[0] as PadVoice;
    for (let v = 0; v < MAX_VOICES; v++) {
      const voice = this.voices[v] as PadVoice;
      if (!voice.reader.active) return voice;
      if (voice.age < pick.age) pick = voice;
    }
    return pick;
  }
}
