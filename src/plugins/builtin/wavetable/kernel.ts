import {
  Adsr,
  at,
  dbToGain,
  InstrumentKernel,
  Lfo,
  Noise,
  polyBlep,
  softClip,
  Svf,
  VoicePool,
  WavetableBank,
  type KernelHost,
  type LfoShape,
  type ParamBlock,
  type Voice,
} from '@agstudio/sdk/worklet';
import { LFO_BEATS, LFO_SHAPES, lfoParam, MOD_SLOTS, modParam, oscParam, wavetableParams } from './params';

type Params = typeof wavetableParams;

const VOICES = 16;
const MAX_UNISON = 8;
/** Modulation, envelopes and pitch update every CONTROL samples; levels and morphs glide in between. */
const CONTROL = 32;
const MAX_EVENTS = 256;
const EVENT_SIZE = 6;
const EV_ON = 1;
const EV_OFF = 2;
const EV_ALL_OFF = 3;
const EV_ALL_OFF_HARD = 4;

// Mod sources and destinations (indexes into MOD_SOURCES / MOD_TARGETS).
const SRC_ENV = 1;
const SRC_LFO1 = 2;
const SRC_LFO2 = 3;
const SRC_VELOCITY = 4;
const SRC_WHEEL = 5;
const SRC_KEY = 6;
const DST_PITCH = 0;
const DST_POS1 = 1;
const DST_POS2 = 2;
const DST_CUTOFF = 3;
const DST_RES = 4;
const DST_AMP = 5;
const DST_PAN = 6;
const DST_LFO1 = 7;
const DST_LFO2 = 8;
const DESTINATIONS = 9;

const MODE_MONO = 1;
const MODE_LEGATO = 2;

/** Oscillator state of one voice (one per oscillator). */
class Osc {
  readonly phase = new Float64Array(MAX_UNISON);
  readonly inc = new Float64Array(MAX_UNISON);
  readonly gl = new Float64Array(MAX_UNISON);
  readonly gr = new Float64Array(MAX_UNISON);
  on = false;
  /** Offsets of the two frames being morphed (at the current mip level), its size, and the morph. */
  a = 0;
  b = 0;
  size = 256;
  frame = -1;
  morph = 0;
  morphStep = 0;
}

/** An oscillator's params at one control step. */
class OscSnap {
  level = 0;
  coarse = 0;
  fine = 0;
  table = 0;
  pan = 0;
  position = 0;
  /** Per-unison-voice levels (left, right), cached while level, pan, spread and unison stay put. */
  readonly gl = new Float64Array(MAX_UNISON);
  readonly gr = new Float64Array(MAX_UNISON);
  gainKey = [NaN, NaN, NaN, NaN];
}

/** An LFO's params at one control step. */
class LfoSnap {
  shape = 0;
  synced = false;
  length = 0;
  rate = 1;
}

/**
 * The params a control step reads, taken once and shared by every voice that controls at the same
 * frame: all of them when no param is automated (the common case), else the voices that step on the
 * same frame. Looking a param up by name is a hash lookup and a voice does dozens of them per step.
 */
class Snap {
  unison = 1;
  detune = 0;
  spread = 0;
  subLevel = 0;
  subShape = 0;
  subOctave = 0;
  noiseLevel = 0;
  noiseTone = 0;
  filterType = 0;
  envAmount = 0;
  keyTrack = 0;
  cutoff = 0;
  resonance = 0;
  drive = 0;
  velocity = 0;
  readonly osc = [new OscSnap(), new OscSnap()];
  readonly lfo = [new LfoSnap(), new LfoSnap()];
  readonly modSource = new Int32Array(MOD_SLOTS);
  readonly modTarget = new Int32Array(MOD_SLOTS);
  readonly modAmount = new Float64Array(MOD_SLOTS);
  /** 2^(detune · position / 1200) for each unison voice, cached while detune and unison stay put. */
  readonly detuneRatio = new Float64Array(MAX_UNISON);
  private ratioKey = [NaN, NaN];

  read(k: WavetableKernel, p: ParamBlock<Params>, i: number): void {
    const v = (id: string) => at(p[id] as Float32Array, i);
    const unison = Math.max(1, Math.min(MAX_UNISON, Math.round(v('unison'))));
    const detune = v('detune');
    const spread = v('spread');
    if (this.ratioKey[0] !== detune || this.ratioKey[1] !== unison) {
      this.ratioKey[0] = detune;
      this.ratioKey[1] = unison;
      for (let u = 0; u < unison; u++) {
        const spreadPos = unison > 1 ? (2 * u) / (unison - 1) - 1 : 0;
        this.detuneRatio[u] = Math.pow(2, (detune * spreadPos) / 1200);
      }
    }
    this.unison = unison;
    this.detune = detune;
    this.spread = spread;
    this.subLevel = v('subLevel');
    this.subShape = Math.round(v('subShape'));
    this.subOctave = v('subOctave');
    this.noiseLevel = v('noiseLevel');
    this.noiseTone = v('noiseTone');
    this.filterType = Math.round(v('filterType'));
    this.envAmount = v('envAmount');
    this.keyTrack = v('keyTrack');
    this.cutoff = v('cutoff');
    this.resonance = v('resonance');
    this.drive = v('drive');
    this.velocity = v('velocity');
    const norm = 1 / Math.sqrt(unison);
    for (let which = 0; which < 2; which++) {
      const o = this.osc[which] as OscSnap;
      const ids = which === 0 ? k.osc1Ids : k.osc2Ids;
      o.level = v(ids.level);
      o.coarse = v(ids.coarse);
      o.fine = v(ids.fine);
      o.table = v(ids.table);
      o.pan = v(ids.pan);
      o.position = v(ids.position);
      const key = o.gainKey;
      if (key[0] !== o.level || key[1] !== o.pan || key[2] !== spread || key[3] !== unison) {
        key[0] = o.level;
        key[1] = o.pan;
        key[2] = spread;
        key[3] = unison;
        for (let u = 0; u < unison; u++) {
          const spreadPos = unison > 1 ? (2 * u) / (unison - 1) - 1 : 0;
          const pan = Math.max(-1, Math.min(1, o.pan + spread * spreadPos));
          o.gl[u] = o.level * norm * Math.sqrt(0.5 * (1 - pan));
          o.gr[u] = o.level * norm * Math.sqrt(0.5 * (1 + pan));
        }
      }
    }
    for (let n = 0; n < 2; n++) {
      const l = this.lfo[n] as LfoSnap;
      const ids = n === 0 ? k.lfo1Ids : k.lfo2Ids;
      l.shape = Math.round(v(ids.shape));
      l.synced = v(ids.sync) >= 0.5;
      l.length = Math.round(v(ids.length));
      l.rate = v(ids.rate);
    }
    for (let m = 0; m < MOD_SLOTS; m++) {
      const id = k.modIds[m] as ReturnType<typeof modParam>;
      this.modSource[m] = Math.round(v(id.source));
      this.modTarget[m] = Math.round(v(id.target));
      this.modAmount[m] = v(id.amount);
    }
  }
}

class WtVoice implements Voice {
  noteId = -1;
  key = 0;
  active = false;
  releasing = false;
  age = 0;
  /** Set up at its first rendered frame (with that block's params). */
  fresh = false;
  velocity = 1;
  notePan = 0;
  fine = 0;
  /** Pitch in semitones, gliding from `glideFrom` to `key` over `glideSteps` control steps. */
  pitch = 60;
  glideFrom = 60;
  glideSteps = 0;
  glideStep = 0;
  readonly ampEnv: Adsr;
  readonly modEnv: Adsr;
  readonly lfo1: Lfo;
  readonly lfo2: Lfo;
  lfo1Value = 0;
  lfo2Value = 0;
  lfo1Rate = 1;
  lfo2Rate = 1;
  readonly osc1 = new Osc();
  readonly osc2 = new Osc();
  unison = 1;
  subPhase = 0;
  subInc = 0;
  subGain = 0;
  noiseGain = 0;
  noiseCoef = 1;
  noiseState = 0;
  readonly noise: Noise;
  readonly f1L = new Svf();
  readonly f1R = new Svf();
  readonly f2L = new Svf();
  readonly f2R = new Svf();
  drive = 0;
  /** The filter design in force (type, cutoff and Q), or NaN when it must be set again. */
  filterType = NaN;
  filterCutoff = NaN;
  filterQ = NaN;
  driveNorm = 1;
  gain = 0;
  gainStep = 0;
  panL = 1;
  panR = 1;
  countdown = 0;

  constructor(controlRate: number, seed: number) {
    this.ampEnv = new Adsr(controlRate);
    this.modEnv = new Adsr(controlRate);
    this.lfo1 = new Lfo(controlRate, 1);
    this.lfo2 = new Lfo(controlRate, 2);
    this.noise = new Noise(seed);
  }
}

/**
 * The Wavetable synth's kernel. Two morphing wavetable oscillators (bank from the main thread, see
 * index.ts) with unison, a sub and noise, a driven state-variable filter, amp and mod envelopes,
 * two LFOs (free or locked to the song position), a 6-slot mod matrix and poly/mono/legato voices
 * with glide. Note events are queued and handled at the start of the next render, with that block's
 * params, so voice modes and settings apply from the very first note of an export.
 */
export class WavetableKernel extends InstrumentKernel<Params> {
  private bank: WavetableBank | null = null;
  private readonly pool: VoicePool<WtVoice>;
  private readonly controlRate: number;
  private readonly events = new Float64Array(MAX_EVENTS * EVENT_SIZE);
  private eventCount = 0;
  /** Held notes for mono/legato (note ids and keys, oldest first). */
  private readonly heldIds = new Float64Array(64);
  private readonly heldKeys = new Float64Array(64);
  private held = 0;
  /** The last note's pitch (where the next note glides from). */
  private lastPitch = -1;
  private wheel = 0;
  private wheelSmooth = 0;
  /** Free-running LFO phases shared by voices that don't restart their LFOs. */
  private readonly lfoPhase = new Float64Array(2);
  private readonly mods = new Float64Array(DESTINATIONS);
  private readonly bufL = new Float64Array(CONTROL);
  private readonly bufR = new Float64Array(CONTROL);
  readonly osc1Ids = oscParam(1);
  readonly osc2Ids = oscParam(2);
  readonly lfo1Ids = lfoParam(1);
  readonly lfo2Ids = lfoParam(2);
  readonly modIds = Array.from({ length: MOD_SLOTS }, (_, i) => modParam(i + 1));

  constructor(host: KernelHost) {
    super(host);
    this.controlRate = host.sampleRate / CONTROL;
    let seed = 1;
    this.pool = new VoicePool(VOICES, () => new WtVoice(this.controlRate, 1000 + 7919 * seed++));
  }

  /** The bank arrives from the main thread once (`{ type: 'bank', data, tables, frames }`). */
  override onMessage(msg: unknown): void {
    const m = msg as { type?: string; data?: Float32Array; tables?: number; frames?: number } | null;
    if (m?.type !== 'bank' || !(m.data instanceof Float32Array) || !m.tables || !m.frames) return;
    this.useBank(WavetableBank.wrap(m.data, m.tables, m.frames));
  }

  useBank(bank: WavetableBank): void {
    this.bank = bank;
  }

  noteOn(key: number, velocity: number, noteId: number, pan: number, fine = 0): void {
    this.push(EV_ON, noteId, key, velocity, pan, fine);
  }

  noteOff(noteId: number, key: number, _release: number): void {
    this.push(EV_OFF, noteId, key, 0, 0, 0);
  }

  override allNotesOff(hard: boolean): void {
    this.push(hard ? EV_ALL_OFF_HARD : EV_ALL_OFF, 0, 0, 0, 0, 0);
  }

  override controlChange(cc: number, value: number): void {
    if (cc === 1) this.wheel = value;
  }

  override reset(): void {
    this.eventCount = 0;
    this.held = 0;
    const voices = this.pool.voices;
    for (let i = 0; i < voices.length; i++) this.silence(voices[i] as WtVoice);
  }

  private push(type: number, id: number, key: number, vel: number, pan: number, fine: number): void {
    if (this.eventCount >= MAX_EVENTS) return;
    const e = this.events;
    const o = this.eventCount++ * EVENT_SIZE;
    e[o] = type;
    e[o + 1] = id;
    e[o + 2] = key;
    e[o + 3] = vel;
    e[o + 4] = pan;
    e[o + 5] = fine;
  }

  render(out: Float32Array[], from: number, to: number, p: ParamBlock<Params>): void {
    if (this.eventCount > 0) this.handleEvents(p, from);
    const bank = this.bank;
    if (!bank) return;
    const n = to - from;
    // Automated params (one value per frame) make the snapshot frame-specific; otherwise it is shared.
    this.seq++;
    let constant = true;
    const names = this.paramNames;
    for (let k = 0; k < names.length; k++)
      if ((p[names[k] as string] as Float32Array).length > 1) {
        constant = false;
        break;
      }
    this.constant = constant;
    // Shared free-running LFO phases (for voices that keep running across notes).
    const r1 = at(p[this.lfo1Ids.rate] as Float32Array, from);
    const r2 = at(p[this.lfo2Ids.rate] as Float32Array, from);
    this.lfoPhase[0] = ((this.lfoPhase[0] as number) + (r1 * n) / this.sampleRate) % 1;
    this.lfoPhase[1] = ((this.lfoPhase[1] as number) + (r2 * n) / this.sampleRate) % 1;
    this.wheelSmooth += (this.wheel - this.wheelSmooth) * Math.min(1, n / (0.02 * this.sampleRate));

    const oL = out[0] as Float32Array;
    const oR = (out[1] ?? out[0]) as Float32Array;
    const master = dbToGain(at(p.level as Float32Array, from)) * 0.5;
    const voices = this.pool.voices;
    for (let vi = 0; vi < voices.length; vi++) {
      const v = voices[vi] as WtVoice;
      if (!v.active) continue;
      let i = 0;
      while (i < n) {
        if (v.countdown <= 0) {
          if (!this.control(v, p, from + i, bank)) break;
          v.countdown = CONTROL;
        }
        const seg = Math.min(v.countdown, n - i);
        this.renderSegment(v, bank, oL, oR, from + i, seg, master);
        v.countdown -= seg;
        i += seg;
      }
    }
  }

  /** Synthesizes `seg` samples of a voice into the output at `start`. */
  private renderSegment(
    v: WtVoice,
    bank: WavetableBank,
    oL: Float32Array,
    oR: Float32Array,
    start: number,
    seg: number,
    master: number,
  ): void {
    const L = this.bufL;
    const R = this.bufR;
    L.fill(0, 0, seg);
    R.fill(0, 0, seg);
    const d = bank.data;
    const unison = v.unison;
    for (let which = 0; which < 2; which++) {
      const osc = which === 0 ? v.osc1 : v.osc2;
      if (!osc.on) continue;
      const a = osc.a;
      const b = osc.b;
      const size = osc.size;
      const m0 = osc.morph;
      const dm = osc.morphStep;
      let u = 0;
      // Two unison voices per pass: half the loop overhead and half the traffic through the mix buffers.
      for (; u + 1 < unison; u += 2) {
        let pa = osc.phase[u] as number;
        let pb = osc.phase[u + 1] as number;
        const ia = osc.inc[u] as number;
        const ib = osc.inc[u + 1] as number;
        const gla = osc.gl[u] as number;
        const gra = osc.gr[u] as number;
        const glb = osc.gl[u + 1] as number;
        const grb = osc.gr[u + 1] as number;
        let m = m0;
        for (let s = 0; s < seg; s++) {
          const xa = pa * size;
          const ja = xa | 0;
          const fa = xa - ja;
          const xb = pb * size;
          const jb = xb | 0;
          const fb = xb - jb;
          const a0 = d[a + ja] as number;
          const b0 = d[b + ja] as number;
          const c0 = d[a + jb] as number;
          const e0 = d[b + jb] as number;
          const ya = a0 + ((d[a + ja + 1] as number) - a0) * fa;
          const yb = b0 + ((d[b + ja + 1] as number) - b0) * fa;
          const yc = c0 + ((d[a + jb + 1] as number) - c0) * fb;
          const ye = e0 + ((d[b + jb + 1] as number) - e0) * fb;
          const y1 = ya + (yb - ya) * m;
          const y2 = yc + (ye - yc) * m;
          L[s] = (L[s] as number) + y1 * gla + y2 * glb;
          R[s] = (R[s] as number) + y1 * gra + y2 * grb;
          pa += ia;
          if (pa >= 1) pa -= 1;
          pb += ib;
          if (pb >= 1) pb -= 1;
          m += dm;
        }
        osc.phase[u] = pa;
        osc.phase[u + 1] = pb;
      }
      for (; u < unison; u++) {
        let ph = osc.phase[u] as number;
        const inc = osc.inc[u] as number;
        const gl = osc.gl[u] as number;
        const gr = osc.gr[u] as number;
        let m = m0;
        for (let s = 0; s < seg; s++) {
          const x = ph * size;
          const j = x | 0;
          const fr = x - j;
          const ya = (d[a + j] as number) + ((d[a + j + 1] as number) - (d[a + j] as number)) * fr;
          const yb = (d[b + j] as number) + ((d[b + j + 1] as number) - (d[b + j] as number)) * fr;
          const y = ya + (yb - ya) * m;
          L[s] = (L[s] as number) + y * gl;
          R[s] = (R[s] as number) + y * gr;
          ph += inc;
          if (ph >= 1) ph -= 1;
          m += dm;
        }
        osc.phase[u] = ph;
      }
      osc.morph = m0 + dm * seg;
    }

    const subGain = v.subGain;
    const noiseGain = v.noiseGain;
    const shape = this.subShape;
    const drive = v.drive;
    const driveNorm = v.driveNorm;
    const steep = this.filterSteep;
    let gain = v.gain;
    const gainStep = v.gainStep;
    const panL = v.panL * master;
    const panR = v.panR * master;
    for (let s = 0; s < seg; s++) {
      let mono = 0;
      if (subGain > 0) {
        const t = v.subPhase;
        const dt = v.subInc;
        let y: number;
        if (shape === 0) y = Math.sin(2 * Math.PI * t);
        else if (shape === 1) y = t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
        else {
          y = t < 0.5 ? 1 : -1;
          y += polyBlep(t, dt);
          let t2 = t - 0.5;
          if (t2 < 0) t2 += 1;
          y -= polyBlep(t2, dt);
        }
        mono += y * subGain;
        let nt = t + dt;
        if (nt >= 1) nt -= 1;
        v.subPhase = nt;
      }
      if (noiseGain > 0) {
        let ns = v.noiseState + v.noiseCoef * (v.noise.white() - v.noiseState);
        if (!(Math.abs(ns) > 1e-20)) ns = 0;
        v.noiseState = ns;
        mono += ns * noiseGain;
      }
      let l = (L[s] as number) + mono;
      let r = (R[s] as number) + mono;
      if (drive > 0) {
        l = softClip(l * drive) * driveNorm;
        r = softClip(r * drive) * driveNorm;
      }
      l = v.f1L.process(l);
      r = v.f1R.process(r);
      if (steep) {
        l = v.f2L.process(l);
        r = v.f2R.process(r);
      }
      gain += gainStep;
      oL[start + s] = (oL[start + s] as number) + l * gain * panL;
      oR[start + s] = (oR[start + s] as number) + r * gain * panR;
    }
    v.gain = gain;
  }

  // Shared per-block settings read by the control step and the segment renderer.
  private subShape = 0;
  private filterSteep = false;
  /** The last resonance seen and its Q (shared by voices: one pow per change, not per voice and step). */
  private lastRes = NaN;
  private lastQ = 0;
  /** The param block and frame the control step reads (see P). */
  private blk: ParamBlock<Params> | null = null;
  private idx = 0;
  /** A param's value at the current control step (one function for the kernel's life: no allocation). */
  private readonly P = (id: string): number => at((this.blk as ParamBlock<Params>)[id] as Float32Array, this.idx);

  /**
   * One control step for a voice: sets a new voice up, runs its envelopes and LFOs, sums the mod
   * matrix, and computes pitch, wavetable frames, levels, pan and filter for the next CONTROL samples.
   * Returns false once the voice has finished.
   */
  private control(v: WtVoice, p: ParamBlock<Params>, i: number, bank: WavetableBank): boolean {
    if (v.fresh) this.setUp(v, p, i);
    if (!v.ampEnv.active) {
      this.silence(v);
      return false;
    }
    const S = this.snapshot(p, i);

    // Envelopes and LFOs.
    const amp = v.ampEnv.next();
    const env = v.modEnv.next();
    v.lfo1Value = this.lfoValue(v.lfo1, S.lfo[0] as LfoSnap, i, v.lfo1Rate);
    v.lfo2Value = this.lfoValue(v.lfo2, S.lfo[1] as LfoSnap, i, v.lfo2Rate);

    // Mod matrix.
    const mods = this.mods;
    mods.fill(0);
    const key = (v.key - 60) / 60;
    for (let s = 0; s < MOD_SLOTS; s++) {
      const src = S.modSource[s] as number;
      if (src === 0) continue;
      const value =
        src === SRC_ENV
          ? env
          : src === SRC_LFO1
            ? v.lfo1Value
            : src === SRC_LFO2
              ? v.lfo2Value
              : src === SRC_VELOCITY
                ? v.velocity
                : src === SRC_WHEEL
                  ? this.wheelSmooth
                  : src === SRC_KEY
                    ? key < -1
                      ? -1
                      : key > 1
                        ? 1
                        : key
                    : 0;
      const dst = S.modTarget[s] as number;
      mods[dst] = (mods[dst] as number) + (S.modAmount[s] as number) * value;
    }
    v.lfo1Rate = mods[DST_LFO1] === 0 ? 1 : Math.pow(2, 4 * (mods[DST_LFO1] as number));
    v.lfo2Rate = mods[DST_LFO2] === 0 ? 1 : Math.pow(2, 4 * (mods[DST_LFO2] as number));

    // Pitch (semitones): the gliding note, the channel pitch, the note's fine pitch and modulation.
    if (v.glideStep < v.glideSteps) {
      v.glideStep++;
      v.pitch = v.glideFrom + ((v.key - v.glideFrom) * v.glideStep) / v.glideSteps;
    } else v.pitch = v.key;
    const semis = v.pitch + (at(this.pitch, i) + v.fine) / 100 + 24 * (mods[DST_PITCH] as number);
    const sr = this.sampleRate;

    // Oscillators.
    const unison = S.unison;
    v.unison = unison;
    for (let which = 0; which < 2; which++) {
      const osc = which === 0 ? v.osc1 : v.osc2;
      const o = S.osc[which] as OscSnap;
      const level = o.level;
      osc.on = level > 0;
      if (!osc.on) continue;
      const base = 440 * Math.pow(2, (semis + o.coarse + o.fine / 100 - 69) / 12);
      const table = Math.max(0, Math.min(bank.tables - 1, Math.round(o.table)));
      let top = 0;
      for (let u = 0; u < unison; u++) {
        const inc = (base * (S.detuneRatio[u] as number)) / sr;
        osc.inc[u] = inc;
        if (inc > top) top = inc;
        osc.gl[u] = o.gl[u] as number;
        osc.gr[u] = o.gr[u] as number;
      }
      // The frames to morph between at the mip level for the highest unison voice.
      const mod = (which === 0 ? mods[DST_POS1] : mods[DST_POS2]) as number;
      const position = Math.max(0, Math.min(1, o.position + mod));
      const fpos = position * (bank.frames - 1);
      const f0 = Math.min(bank.frames - 2 < 0 ? 0 : bank.frames - 2, Math.floor(fpos));
      const frac = bank.frames > 1 ? fpos - f0 : 0;
      const level2 = WavetableBank.levelFor(top);
      const frameKey = (table * 64 + f0) * 16 + level2;
      if (frameKey !== osc.frame) {
        // Crossing to another frame pair (or level): continuous, since neighbours share a frame.
        osc.frame = frameKey;
        osc.a = bank.offset(table, f0, level2);
        osc.b = bank.offset(table, Math.min(bank.frames - 1, f0 + 1), level2);
        osc.size = WavetableBank.size(level2);
        osc.morph = frac;
        osc.morphStep = 0;
      } else osc.morphStep = (frac - osc.morph) / CONTROL;
    }

    // Sub (an octave or two below the note) and noise, centred.
    const subLevel = S.subLevel;
    v.subGain = subLevel * 0.7;
    this.subShape = S.subShape;
    if (subLevel > 0)
      v.subInc = Math.min(0.45, ((440 * Math.pow(2, (semis - 69) / 12)) / sr) * (S.subOctave >= 0.5 ? 0.25 : 0.5));
    const noiseLevel = S.noiseLevel;
    v.noiseGain = noiseLevel * 0.5;
    if (noiseLevel > 0)
      v.noiseCoef = 1 - Math.exp((-2 * Math.PI * Math.min(0.45 * sr, 200 * Math.pow(100, S.noiseTone))) / sr);

    // Filter: cutoff with key tracking, the envelope amount and modulation (in octaves).
    const type = S.filterType;
    this.filterSteep = type === 1;
    const octaves = 8 * (S.envAmount * env + (mods[DST_CUTOFF] as number));
    const tracked = (S.keyTrack * (v.pitch - 60)) / 12;
    const cutoff = Math.max(20, Math.min(0.45 * sr, S.cutoff * Math.pow(2, octaves + tracked)));
    const res = Math.max(0, Math.min(1, S.resonance + (mods[DST_RES] as number)));
    if (res !== this.lastRes) {
      this.lastRes = res;
      this.lastQ = 0.6 * Math.pow(30, res);
    }
    const q = this.lastQ;
    // Both channels share one filter design, which is only recomputed when it changes (a filter that
    // nothing modulates keeps the same cutoff for the whole note).
    if (type !== v.filterType || cutoff !== v.filterCutoff || q !== v.filterQ) {
      v.filterType = type;
      v.filterCutoff = cutoff;
      v.filterQ = q;
      if (this.filterSteep) {
        v.f1L.set('lowpass', cutoff, 0.6, sr);
        v.f1R.copyDesign(v.f1L);
        v.f2L.set('lowpass', cutoff, q, sr);
        v.f2R.copyDesign(v.f2L);
      } else {
        const kind = type === 2 ? 'highpass' : type === 3 ? 'bandpass' : type === 4 ? 'notch' : 'lowpass';
        v.f1L.set(kind, cutoff, q, sr);
        v.f1R.copyDesign(v.f1L);
      }
    }
    const drive = S.drive;
    v.drive = drive > 0 ? 1 + 6 * drive : 0;
    v.driveNorm = drive > 0 ? 1 / softClip(v.drive) : 1;

    // Level (envelope, velocity, modulation) gliding over the step, and pan.
    const sens = S.velocity;
    const ampMod = Math.max(0, Math.min(2, 1 + (mods[DST_AMP] as number)));
    const target = amp * (1 - sens + sens * v.velocity) * ampMod;
    v.gainStep = (target - v.gain) / CONTROL;
    const pan = Math.max(-1, Math.min(1, v.notePan + (mods[DST_PAN] as number)));
    v.panL = Math.min(1, 1 - pan);
    v.panR = Math.min(1, 1 + pan);
    return true;
  }

  private readonly snap = new Snap();
  /** Which render call and frame the snapshot was taken at (see Snap). */
  private snapSeq = -1;
  private snapAt = -1;
  private seq = 0;
  /** True while no param is automated in this render call: the snapshot is then good for every frame. */
  private constant = true;
  private readonly paramNames = Object.keys(wavetableParams);

  /** The params at frame `i` of this render call (one shared read per frame, or per call when constant). */
  private snapshot(p: ParamBlock<Params>, i: number): Snap {
    const frame = this.constant ? 0 : i;
    if (this.snapSeq !== this.seq || this.snapAt !== frame) {
      this.snap.read(this, p, i);
      this.snapSeq = this.seq;
      this.snapAt = frame;
    }
    return this.snap;
  }

  /** The LFO's value: locked to the song while it plays when synced, else free-running. */
  private lfoValue(lfo: Lfo, l: LfoSnap, i: number, rateFactor: number): number {
    lfo.shape = LFO_SHAPES[l.shape] as LfoShape;
    const beats = LFO_BEATS[l.length] ?? 1;
    if (l.synced && this.transport.playing) return lfo.atBeat(this.transport.beatAt(i), beats / rateFactor);
    const hz = l.synced ? this.transport.bpm / 60 / beats : l.rate;
    return lfo.next(hz * rateFactor);
  }

  /** A new note's voice, at its first rendered frame. */
  private setUp(v: WtVoice, p: ParamBlock<Params>, i: number): void {
    this.blk = p;
    this.idx = i;
    const P = this.P;
    v.fresh = false;
    // A voice taken over from a sounding note (or a mono retrigger) keeps its level and phases.
    const stolen = v.gain > 0;
    v.ampEnv.set(P('ampAttack'), P('ampDecay'), P('ampSustain'), P('ampRelease'));
    v.modEnv.set(P('modAttack'), P('modDecay'), P('modSustain'), P('modRelease'));
    if (!stolen) {
      v.ampEnv.reset();
      v.modEnv.reset();
      v.gain = 0;
      v.subPhase = 0;
      v.noiseState = 0;
      v.f1L.reset();
      v.f1R.reset();
      v.f2L.reset();
      v.f2R.reset();
      for (let which = 0; which < 2; which++) {
        const osc = which === 0 ? v.osc1 : v.osc2;
        osc.frame = -1;
        // One voice starts at phase 0 (a consistent attack); unison copies start anywhere.
        for (let u = 0; u < MAX_UNISON; u++) osc.phase[u] = u === 0 ? 0 : this.host.rand();
      }
    }
    v.ampEnv.start();
    v.modEnv.start();
    for (let n = 0; n < 2; n++) {
      const ids = n === 0 ? this.lfo1Ids : this.lfo2Ids;
      const lfo = n === 0 ? v.lfo1 : v.lfo2;
      lfo.reset(P(ids.retrigger) >= 0.5 ? 0 : (this.lfoPhase[n] as number));
    }
  }

  private silence(v: WtVoice): void {
    this.pool.free(v);
    v.fresh = false;
    v.gain = 0;
    v.gainStep = 0;
    v.ampEnv.reset();
    v.modEnv.reset();
  }

  /** Starts, glides and releases voices for the queued note events (poly, mono or legato). */
  private handleEvents(p: ParamBlock<Params>, i: number): void {
    const mode = Math.round(at(p.voiceMode as Float32Array, i));
    const glideSteps = Math.round((at(p.glide as Float32Array, i) * this.sampleRate) / CONTROL);
    const e = this.events;
    for (let n = 0; n < this.eventCount; n++) {
      const o = n * EVENT_SIZE;
      const type = e[o] as number;
      const id = e[o + 1] as number;
      const key = e[o + 2] as number;
      if (type === EV_ON)
        this.start(id, key, e[o + 3] as number, e[o + 4] as number, e[o + 5] as number, mode, glideSteps);
      else if (type === EV_OFF) this.stop(id, mode, glideSteps);
      else this.stopAll(type === EV_ALL_OFF_HARD);
    }
    this.eventCount = 0;
  }

  private start(id: number, key: number, vel: number, pan: number, fine: number, mode: number, glide: number) {
    const from = this.lastPitch;
    this.lastPitch = key;
    if (mode === MODE_MONO || mode === MODE_LEGATO) {
      const wasHeld = this.held > 0;
      if (this.held < this.heldIds.length) {
        this.heldIds[this.held] = id;
        this.heldKeys[this.held] = key;
        this.held++;
      }
      const v = this.pool.voices[0] as WtVoice;
      // Only the first voice plays in mono modes.
      for (let k = 1; k < this.pool.voices.length; k++) {
        const other = this.pool.voices[k] as WtVoice;
        if (other.active) this.release(other);
      }
      const sounding = v.active && !v.releasing;
      v.noteId = id;
      v.velocity = vel;
      v.notePan = pan;
      v.fine = fine;
      this.glideTo(v, key, sounding && glide > 0 ? v.pitch : from >= 0 && glide > 0 ? from : key, glide);
      if (mode === MODE_LEGATO && wasHeld && sounding) return; // slide, no new attack
      v.active = true;
      v.releasing = false;
      v.fresh = true;
      v.countdown = 0;
      return;
    }
    const v = this.pool.start(id, key);
    v.fresh = true;
    v.velocity = vel;
    v.notePan = pan;
    v.fine = fine;
    v.countdown = 0;
    this.glideTo(v, key, from >= 0 && glide > 0 ? from : key, glide);
  }

  private glideTo(v: WtVoice, key: number, from: number, steps: number): void {
    v.key = key;
    v.glideFrom = from;
    v.glideSteps = from === key ? 0 : steps;
    v.glideStep = 0;
    if (v.glideSteps === 0) v.pitch = key;
  }

  private stop(id: number, mode: number, glide: number): void {
    if (mode === MODE_MONO || mode === MODE_LEGATO) {
      let at = -1;
      for (let k = 0; k < this.held; k++) if (this.heldIds[k] === id) at = k;
      if (at >= 0) {
        for (let k = at; k < this.held - 1; k++) {
          this.heldIds[k] = this.heldIds[k + 1] as number;
          this.heldKeys[k] = this.heldKeys[k + 1] as number;
        }
        this.held--;
      }
      const v = this.pool.voices[0] as WtVoice;
      if (!v.active || v.noteId !== id) return;
      if (this.held > 0) {
        // Back to the most recent key still held, without a new attack.
        const key = this.heldKeys[this.held - 1] as number;
        v.noteId = this.heldIds[this.held - 1] as number;
        this.glideTo(v, key, glide > 0 ? v.pitch : key, glide);
        this.lastPitch = key;
        return;
      }
      this.release(v);
      return;
    }
    const v = this.pool.find(id);
    if (v) this.release(v);
  }

  private release(v: WtVoice): void {
    // Released before it ever sounded: the note was cancelled.
    if (v.fresh) {
      this.silence(v);
      return;
    }
    v.releasing = true;
    v.ampEnv.release();
    v.modEnv.release();
  }

  private stopAll(hard: boolean): void {
    this.held = 0;
    const voices = this.pool.voices;
    for (let k = 0; k < voices.length; k++) {
      const v = voices[k] as WtVoice;
      if (!v.active) continue;
      if (hard) this.silence(v);
      else this.release(v);
    }
  }
}
