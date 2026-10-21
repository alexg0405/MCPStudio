// Pure DSP, no AudioWorklet globals, so it can be tested in Node. Rules: no allocation inside render().
import {
  at,
  dbToGain,
  FmOperator,
  InstrumentKernel,
  mtof,
  VoicePool,
  type ParamBlock,
  type Voice,
} from '@agstudio/sdk/worklet';
import type { params } from './params';

const VOICES = 12;
/** A fade of 60 dB is a factor of a thousand. */
const SIXTY_DB = 1000;
/** The voice is let go once it is quieter than this (linear). */
const SILENT = 0.0001;
/** The bright part of the bell (the modulator) fades this much faster than the loudness. */
const BRIGHT_FADES_FASTER = 2;
/** Keeps a full chord of bells under 0 dBFS at the default level. */
const VOICE_HEADROOM = 0.3;

class BellVoice implements Voice {
  noteId = -1;
  key = 0;
  active = false;
  releasing = false;
  age = 0;
  /** Cycles per sample of the note. */
  inc = 0;
  velocity = 0;
  loudness = 0;
  brightness = 0;
  readonly carrier = new FmOperator();
  readonly modulator = new FmOperator();
}

/** The factor that takes a level down by 60 dB in `seconds`, applied once per sample. */
const fadePerSample = (seconds: number, sampleRate: number): number => Math.pow(1 / SIXTY_DB, 1 / (Math.max(0.01, seconds) * sampleRate));

/**
 * A bell from two sine operators: the modulator bends the carrier's phase (FM), and both fade away like a struck metal
 * bar, the bright part faster. A note off damps the bell quickly.
 */
export class FmBellKernel extends InstrumentKernel<typeof params> {
  private readonly pool = new VoicePool(VOICES, () => new BellVoice());

  noteOn(key: number, velocity: number, noteId: number, _pan: number, fine: number): void {
    const voice = this.pool.start(noteId, key);
    voice.inc = mtof(key + (fine + at(this.pitch, 0)) / 100) / this.sampleRate;
    voice.velocity = velocity;
    voice.loudness = 1;
    voice.brightness = 1;
    voice.carrier.phase = 0;
    voice.carrier.out = 0;
    voice.modulator.phase = 0;
    voice.modulator.out = 0;
  }

  noteOff(noteId: number): void {
    this.pool.release(noteId);
  }

  override allNotesOff(hard: boolean): void {
    if (hard) this.pool.freeAll();
    else this.pool.releaseAll();
  }

  render(out: Float32Array[], from: number, to: number, p: ParamBlock<typeof params>): void {
    const left = out[0] as Float32Array;
    const right = out[1] ?? left;
    const gain = dbToGain(at(p.level, from)) * VOICE_HEADROOM;
    const ratio = at(p.ratio, from);
    const brightness = at(p.brightness, from);
    const ringFade = fadePerSample(at(p.ring, from), this.sampleRate);
    const brightFade = fadePerSample(at(p.ring, from) / BRIGHT_FADES_FASTER, this.sampleRate);
    const releaseFade = fadePerSample(at(p.release, from), this.sampleRate);
    const voices = this.pool.voices;
    for (let v = 0; v < voices.length; v++) {
      const voice = voices[v] as BellVoice;
      if (!voice.active) continue;
      for (let i = from; i < to; i++) {
        const bend = voice.modulator.next(voice.inc * ratio, 0, brightness * voice.brightness);
        const sample = voice.carrier.next(voice.inc, bend, voice.velocity * voice.loudness) * gain;
        left[i] = (left[i] as number) + sample;
        right[i] = (right[i] as number) + sample;
        voice.loudness *= voice.releasing ? Math.min(ringFade, releaseFade) : ringFade;
        voice.brightness *= voice.releasing ? Math.min(brightFade, releaseFade) : brightFade;
        if (voice.loudness < SILENT) {
          this.pool.free(voice);
          break;
        }
      }
    }
  }
}
