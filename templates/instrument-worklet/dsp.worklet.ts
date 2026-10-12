// Runs on the audio thread. Rules: no DOM, no fetch, no npm packages, no allocation inside render().
import {
  at,
  dbToGain,
  InstrumentKernel,
  mtof,
  registerKernel,
  VoicePool,
  type ParamBlock,
  type Voice,
} from '@agstudio/sdk/worklet';
import { ID, params } from './params';

class SynthVoice implements Voice {
  noteId = -1;
  key = 0;
  active = false;
  releasing = false;
  age = 0;
  phase = 0;
  inc = 0;
  amp = 0;
  env = 0;
}

class Synth extends InstrumentKernel<typeof params> {
  private readonly pool = new VoicePool(16, () => new SynthVoice());

  noteOn(key: number, velocity: number, noteId: number): void {
    const v = this.pool.start(noteId, key);
    v.inc = mtof(key) / this.sampleRate;
    v.amp = velocity;
    v.env = 0;
  }

  noteOff(noteId: number): void {
    this.pool.release(noteId);
  }

  override allNotesOff(hard: boolean): void {
    if (hard) this.pool.freeAll();
    else this.pool.releaseAll();
  }

  render(out: Float32Array[], from: number, to: number, p: ParamBlock<typeof params>): void {
    const L = out[0]!;
    const R = out[1] ?? L;
    const gain = dbToGain(at(p.level, from));
    const shape = at(p.shape, from);
    const releaseStep = 1 / (at(p.release, from) * this.sampleRate);
    const voices = this.pool.voices;
    for (let n = 0; n < voices.length; n++) {
      const v = voices[n]!;
      if (!v.active) continue;
      for (let i = from; i < to; i++) {
        // Short attack ramp, linear release.
        v.env = v.releasing ? v.env - releaseStep : Math.min(1, v.env + 0.005);
        if (v.env <= 0) {
          this.pool.free(v);
          break;
        }
        const sine = Math.sin(2 * Math.PI * v.phase);
        const saw = 2 * v.phase - 1;
        const x = (sine + shape * (saw - sine)) * v.amp * v.env * gain;
        L[i]! += x;
        R[i]! += x;
        v.phase += v.inc;
        if (v.phase >= 1) v.phase -= 1;
      }
    }
  }
}

registerKernel(ID, params, Synth);
