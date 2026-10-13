import {
  InstrumentKernel,
  VoicePool,
  at,
  mtof,
  type KernelHost,
  type ParamBlock,
  type Voice,
} from '@agstudio/sdk/worklet';
import type { pluckParams } from './params';

const MAX_DELAY = 4096;

class PluckVoice implements Voice {
  noteId = -1;
  key = 0;
  active = false;
  releasing = false;
  age = 0;
  buf = new Float32Array(MAX_DELAY);
  len = 1;
  pos = 0;
  /** One-pole low-pass state in the loop. */
  lp = 0;
  /** First-order all-pass (fractional delay) state. */
  apX = 0;
  apY = 0;
  apC = 0;
  freq = 440;
  amp = 0;
  pan = 0;
  quiet = 0;
}

/**
 * Karplus-Strong plucked string. Built as a worklet kernel because a native Web Audio feedback
 * loop can't be shorter than one 128-frame block (anything above ~375 Hz would be impossible).
 */
export class PluckKernel extends InstrumentKernel<typeof pluckParams> {
  private readonly pool = new VoicePool(16, () => new PluckVoice());

  constructor(host: KernelHost) {
    super(host);
  }

  noteOn(key: number, velocity: number, noteId: number, pan: number, fine = 0): void {
    const v = this.pool.start(noteId, key);
    const sr = this.sampleRate;
    // A string's length is fixed while it rings: the note's fine pitch and the channel pitch apply at the pluck.
    v.freq = mtof(key + (fine + at(this.pitch, 0)) / 100);
    // Loop delay = N (buffer) + 0.5 (averaging filter) + d (all-pass) = sr / f.
    const total = Math.min(MAX_DELAY - 1, sr / v.freq);
    const n = Math.max(2, Math.floor(total - 0.5 - 0.01));
    const d = total - 0.5 - n;
    v.len = n;
    v.apC = (1 - d) / (1 + d);
    v.apX = 0;
    v.apY = 0;
    v.pos = 0;
    v.lp = 0;
    v.amp = velocity;
    v.pan = pan;
    v.quiet = 0;
    // Excite with filtered noise; `tone` sets the brightness of the pick.
    const tone = this.lastTone;
    const a = 0.05 + 0.95 * tone;
    let y = 0;
    let mean = 0;
    for (let i = 0; i < n; i++) {
      y += a * (this.host.rand() * 2 - 1 - y);
      v.buf[i] = y;
      mean += y;
    }
    mean /= n;
    for (let i = 0; i < n; i++) v.buf[i] = (v.buf[i] as number) - mean;
  }

  noteOff(noteId: number): void {
    this.pool.release(noteId);
  }

  override allNotesOff(hard: boolean): void {
    if (hard) this.pool.freeAll();
    else this.pool.releaseAll();
  }

  override reset(): void {
    this.pool.freeAll();
  }

  private lastTone = 0.6;

  render(out: Float32Array[], from: number, to: number, params: ParamBlock<typeof pluckParams>): void {
    const L = out[0] as Float32Array;
    const R = (out[1] ?? out[0]) as Float32Array;
    const sr = this.sampleRate;
    this.lastTone = at(params.tone, from);
    const decay = at(params.decay, from);
    const release = at(params.release, from);
    const damping = at(params.damping, from);
    const width = at(params.width, from);
    const level = Math.pow(10, at(params.level, from) / 20);
    const voices = this.pool.voices;
    for (let vi = 0; vi < voices.length; vi++) {
      const v = voices[vi] as PluckVoice;
      if (!v.active) continue;
      // Loop gain per period for a T60 of `decay` (or `release` once released).
      const t60 = v.releasing ? Math.min(release, decay) : decay;
      const g = Math.pow(10, -3 / (t60 * v.freq));
      const damp = 0.5 + 0.49 * damping;
      const pan = Math.max(-1, Math.min(1, v.pan + (((v.key * 7) % 12) / 11 - 0.5) * width));
      const gl = v.amp * level * Math.sqrt(0.5 * (1 - pan));
      const gr = v.amp * level * Math.sqrt(0.5 * (1 + pan));
      let peak = 0;
      for (let i = from; i < to; i++) {
        const x = v.buf[v.pos] as number;
        // Averaging low-pass (half-sample delay) blended with damping, then fractional all-pass.
        const avg = x + damp * (v.lp - x);
        v.lp = x;
        const ap = v.apC * avg + v.apX - v.apC * v.apY;
        v.apX = avg;
        v.apY = ap;
        let fb = ap * g;
        if (!(Math.abs(fb) > 1e-20)) fb = 0;
        v.buf[v.pos] = fb;
        v.pos = v.pos + 1 === v.len ? 0 : v.pos + 1;
        L[i] = (L[i] as number) + x * gl;
        R[i] = (R[i] as number) + x * gr;
        const ax = Math.abs(x);
        if (ax > peak) peak = ax;
      }
      // Free voices that have died away.
      v.quiet = peak < 1e-4 ? v.quiet + (to - from) : 0;
      if (v.quiet > sr * 0.05) this.pool.free(v);
    }
  }
}
