import {
  Adsr,
  at,
  dbToGain,
  FM_ALGORITHMS,
  FmOperator,
  InstrumentKernel,
  mtof,
  sinCycles,
  Svf,
  VoicePool,
  type KernelHost,
  type ParamBlock,
  type Voice,
} from '@agstudio/sdk/worklet';
import { opParam, OPERATORS, type fmParams } from './params';

type Params = typeof fmParams;

/** Envelopes, pitch and levels update every CONTROL samples; levels glide linearly in between. */
const CONTROL = 16;
const VOICES = 16;
/** A modulator at full level shifts the phase of what it feeds by up to 2π radians. */
const MOD_DEPTH = 2 * Math.PI;
const MAX_BLOCK = 4096;

/** Per algorithm: which operator modulates which (4×4, [target][source]) and which are heard. */
const ROUTES = FM_ALGORITHMS.map((alg) => {
  const m = new Float64Array(16);
  alg.modulators.forEach((sources, target) => sources.forEach((s) => (m[target * 4 + s] = 1)));
  const heard = new Float64Array(4);
  for (const c of alg.carriers) heard[c] = 1;
  return { m, heard, gain: 1 / Math.sqrt(alg.carriers.length) };
});

class FmVoice implements Voice {
  noteId = -1;
  key = 0;
  active = false;
  releasing = false;
  age = 0;
  /** Started but not yet set up (that happens at its first rendered frame, with that block's params). */
  fresh = false;
  velocity = 1;
  fine = 0;
  gl = Math.SQRT1_2;
  gr = Math.SQRT1_2;
  readonly op0 = new FmOperator();
  readonly op1 = new FmOperator();
  readonly op2 = new FmOperator();
  readonly op3 = new FmOperator();
  readonly env: Adsr[];
  /** Current level of each operator, its per-sample step towards the next control target, and increments. */
  readonly amp = new Float64Array(4);
  readonly step = new Float64Array(4);
  readonly inc = new Float64Array(4);
  countdown = 0;
  vibrato = 0;

  constructor(controlRate: number) {
    this.env = [new Adsr(controlRate), new Adsr(controlRate), new Adsr(controlRate), new Adsr(controlRate)];
  }
}

/**
 * Four-operator FM (phase modulation) synth: the eight classic 4-op algorithms, feedback on
 * operator 4, an ADSR and velocity sensitivity per operator, an optional low-pass "tone" filter,
 * vibrato and the mod wheel. 16 voices.
 */
export class FmKernel extends InstrumentKernel<Params> {
  private readonly pool: VoicePool<FmVoice>;
  private readonly ids = Array.from({ length: OPERATORS }, (_, i) => opParam(i + 1));
  private wheel = 0;
  private readonly bufL = new Float32Array(MAX_BLOCK);
  private readonly bufR = new Float32Array(MAX_BLOCK);
  private readonly svfL = new Svf();
  private readonly svfR = new Svf();
  private filterKey = -1;

  constructor(host: KernelHost) {
    super(host);
    const controlRate = host.sampleRate / CONTROL;
    this.pool = new VoicePool(VOICES, () => new FmVoice(controlRate));
  }

  noteOn(key: number, velocity: number, noteId: number, pan: number, fine = 0): void {
    const v = this.pool.start(noteId, key);
    v.fresh = true;
    v.velocity = velocity;
    v.fine = fine;
    const x = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    v.gl = Math.sqrt(0.5 * (1 - x));
    v.gr = Math.sqrt(0.5 * (1 + x));
    v.countdown = 0;
  }

  noteOff(noteId: number, _key: number, _release: number): void {
    const v = this.pool.find(noteId);
    if (!v) return;
    // Released before it ever sounded: the note was cancelled.
    if (v.fresh) {
      this.silence(v);
      return;
    }
    v.releasing = true;
    for (let o = 0; o < 4; o++) (v.env[o] as Adsr).release();
  }

  override allNotesOff(hard: boolean): void {
    const voices = this.pool.voices;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i] as FmVoice;
      if (!v.active) continue;
      if (hard || v.fresh) this.silence(v);
      else this.noteOff(v.noteId, v.key, 0.5);
    }
  }

  override controlChange(cc: number, value: number): void {
    if (cc === 1) this.wheel = value;
  }

  override reset(): void {
    const voices = this.pool.voices;
    for (let i = 0; i < voices.length; i++) this.silence(voices[i] as FmVoice);
    this.svfL.reset();
    this.svfR.reset();
  }

  /** Frees a voice and clears its levels (the next note on it starts from silence). */
  private silence(v: FmVoice): void {
    this.pool.free(v);
    v.fresh = false;
    v.amp.fill(0);
    v.step.fill(0);
    for (let o = 0; o < 4; o++) (v.env[o] as Adsr).reset();
  }

  render(out: Float32Array[], from: number, to: number, p: ParamBlock<Params>): void {
    const n = to - from;
    if (n <= 0) return;
    const L = this.bufL;
    const R = this.bufR;
    L.fill(0, 0, n);
    R.fill(0, 0, n);
    const route = ROUTES[Math.round(at(p.algorithm as Float32Array, from))] ?? (ROUTES[0] as (typeof ROUTES)[number]);
    const m = route.m;
    // Operator 4 (index 3) is never modulated by the others; 3 only by 4; 2 by 3 and 4; 1 by all.
    const m23 = (m[2 * 4 + 3] as number) * MOD_DEPTH;
    const m12 = (m[1 * 4 + 2] as number) * MOD_DEPTH;
    const m13 = (m[1 * 4 + 3] as number) * MOD_DEPTH;
    const m01 = (m[1] as number) * MOD_DEPTH;
    const m02 = (m[2] as number) * MOD_DEPTH;
    const m03 = (m[3] as number) * MOD_DEPTH;
    const c0 = (route.heard[0] as number) * route.gain;
    const c1 = (route.heard[1] as number) * route.gain;
    const c2 = (route.heard[2] as number) * route.gain;
    const c3 = (route.heard[3] as number) * route.gain;
    const fb = at(p.feedback as Float32Array, from);
    let sounding = 0;

    const voices = this.pool.voices;
    for (let vi = 0; vi < voices.length; vi++) {
      const v = voices[vi] as FmVoice;
      if (!v.active) continue;
      sounding++;
      const amp = v.amp;
      const step = v.step;
      const inc = v.inc;
      for (let i = 0; i < n; i++) {
        if (v.countdown <= 0) {
          if (!this.control(v, p, from + i, route.heard)) break;
          v.countdown = CONTROL;
        }
        v.countdown--;
        const a0 = (amp[0] = (amp[0] as number) + (step[0] as number));
        const a1 = (amp[1] = (amp[1] as number) + (step[1] as number));
        const a2 = (amp[2] = (amp[2] as number) + (step[2] as number));
        const a3 = (amp[3] = (amp[3] as number) + (step[3] as number));
        const y3 = v.op3.feedback(inc[3] as number, fb, a3);
        const y2 = v.op2.next(inc[2] as number, m23 * y3, a2);
        const y1 = v.op1.next(inc[1] as number, m12 * y2 + m13 * y3, a1);
        const y0 = v.op0.next(inc[0] as number, m01 * y1 + m02 * y2 + m03 * y3, a0);
        const s = c0 * y0 + c1 * y1 + c2 * y2 + c3 * y3;
        L[i] = (L[i] as number) + s * v.gl;
        R[i] = (R[i] as number) + s * v.gr;
      }
    }
    if (sounding === 0 && this.filterKey < 0) return;

    // The tone filter (off at the top of its range), then the volume.
    const cutoff = at(p.cutoff as Float32Array, from);
    const filtered = cutoff < 19900;
    if (filtered) {
      const res = at(p.resonance as Float32Array, from);
      const key = cutoff * 10 + res;
      if (key !== this.filterKey) {
        const q = 0.707 * Math.pow(16, res);
        this.svfL.set('lowpass', cutoff, q, this.sampleRate);
        this.svfR.set('lowpass', cutoff, q, this.sampleRate);
        this.filterKey = key;
      }
    } else if (this.filterKey >= 0) {
      this.filterKey = -1;
      this.svfL.reset();
      this.svfR.reset();
    }
    const gain = dbToGain(at(p.level as Float32Array, from)) * 0.5;
    const oL = out[0] as Float32Array;
    const oR = (out[1] ?? out[0]) as Float32Array;
    for (let i = 0; i < n; i++) {
      let l = L[i] as number;
      let r = R[i] as number;
      if (filtered) {
        l = this.svfL.process(l);
        r = this.svfR.process(r);
      }
      oL[from + i] = (oL[from + i] as number) + l * gain;
      oR[from + i] = (oR[from + i] as number) + r * gain;
    }
  }

  /**
   * Sets up a new voice and computes the next control step: envelope levels, operator levels
   * (gliding there over CONTROL samples) and frequencies. Returns false once the voice has ended.
   */
  private control(v: FmVoice, p: ParamBlock<Params>, i: number, heard: Float64Array): boolean {
    const ids = this.ids;
    if (v.fresh) {
      v.fresh = false;
      // A voice taken from a sounding note keeps its levels and phases (no click) and its
      // envelopes start again from where they are.
      const stolen = v.amp[0] !== 0 || v.amp[1] !== 0 || v.amp[2] !== 0 || v.amp[3] !== 0;
      for (let o = 0; o < 4; o++) {
        const id = ids[o] as ReturnType<typeof opParam>;
        const env = v.env[o] as Adsr;
        if (!stolen) env.reset();
        env.set(
          at(p[id.attack] as Float32Array, i),
          at(p[id.decay] as Float32Array, i),
          at(p[id.sustain] as Float32Array, i),
          at(p[id.release] as Float32Array, i),
        );
        env.start();
      }
      if (!stolen) {
        // Yamaha-style: every note starts its operators at phase 0, so attacks are consistent.
        v.op0.reset();
        v.op1.reset();
        v.op2.reset();
        v.op3.reset();
        v.vibrato = 0;
      }
    }
    // Done when every operator you hear has faded out.
    let alive = false;
    for (let o = 0; o < 4; o++) if ((heard[o] as number) > 0 && (v.env[o] as Adsr).active) alive = true;
    if (!alive) {
      this.silence(v);
      return false;
    }

    const wheelMode = Math.round(at(p.wheel as Float32Array, i));
    const bright = wheelMode === 0 ? 1 + this.wheel : 1;
    const depth = at(p.vibratoDepth as Float32Array, i) + (wheelMode === 1 ? 50 * this.wheel : 0);
    let cents = at(this.pitch, i) + v.fine;
    if (depth > 0) {
      v.vibrato += (at(p.vibratoRate as Float32Array, i) * CONTROL) / this.sampleRate;
      if (v.vibrato >= 1) v.vibrato -= 1;
      cents += depth * sinCycles(v.vibrato);
    }
    const base = (mtof(v.key) * Math.pow(2, cents / 1200)) / this.sampleRate;
    for (let o = 0; o < 4; o++) {
      const id = ids[o] as ReturnType<typeof opParam>;
      const ratio = Math.round(at(p[id.ratio] as Float32Array, i));
      const mult = (ratio === 0 ? 0.5 : ratio) * (1 + at(p[id.fine] as Float32Array, i));
      // Keep every operator below Nyquist (a 16× ratio on a high note would alias).
      v.inc[o] = Math.min(0.45, base * mult);
      const level = at(p[id.level] as Float32Array, i);
      const sens = at(p[id.velocity] as Float32Array, i);
      const env = (v.env[o] as Adsr).next();
      let target = level * level * env * (1 - sens + sens * v.velocity);
      if ((heard[o] as number) === 0) target *= bright;
      v.step[o] = (target - (v.amp[o] as number)) / CONTROL;
    }
    return true;
  }
}
