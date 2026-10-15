// Runs on the audio thread. No DOM, no allocation inside render().
import { at, dbToGain, InstrumentKernel, mtof, registerKernel, type ParamBlock } from '@agstudio/sdk/worklet';
import { ID, params } from './params';

const NP = 9;
const RATIOS = [0.5, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.2, 5.4];
const DEV = [-0.015, 0.0, 0.035, -0.04, 0.02, 0.06, -0.05, 0.09, 0.12];
const BASE = [0.55, 1.0, 0.55, 0.3, 0.65, 0.4, 0.32, 0.25, 0.18];
const DK = [1.0, 0.75, 0.55, 0.45, 0.4, 0.22, 0.17, 0.1, 0.07];
const SPREAD = [0, 0, -0.35, 0.45, -0.55, 0.7, -0.8, 0.9, -1];
const MAX_VOICES = 16;
const SOFT_LIMIT = 8;
const LN1000 = 6.907755;
const TWO_PI = 2 * Math.PI;

class BellVoice {
  active = false;
  choking = false;
  age = 0;
  key = 0;
  fade = 1;
  fadeStep = 0;
  px = new Float64Array(NP);
  py = new Float64Array(NP);
  pe = new Float64Array(NP);
  pa = new Float64Array(NP);
  pd = new Float64Array(NP);
  pl = new Float64Array(NP);
  pr = new Float64Array(NP);
  subPhase = 0;
  subInc = 0;
  subAmp = 0;
  subMul = 1;
  subBend = 0;
  subBendMul = 1;
  nAmp = 0;
  nMul = 1;
  ic1 = 0;
  ic2 = 0;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  cPhase = 0;
  cAmp = 0;
  cMul = 1;
  cBase = 0;
  cExtra = 0;
  cDropMul = 1;
}

class YeatBell extends InstrumentKernel<typeof params> {
  private readonly voices: BellVoice[] = [];
  private readonly qKey = new Float64Array(64);
  private readonly qVel = new Float64Array(64);
  private readonly qFine = new Float64Array(64);
  private qCount = 0;
  private counter = 0;
  private seed = 1;

  constructor(...args: ConstructorParameters<typeof InstrumentKernel<typeof params>>) {
    super(...args);
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new BellVoice());
    this.seed = ((this.host.rand() * 4294967295) | 0) || 12345;
  }

  private noise(): number {
    let s = this.seed | 0;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s;
    return s / 2147483648;
  }

  noteOn(key: number, velocity: number, _noteId: number, _pan: number, fine: number): void {
    if (this.qCount >= 64) return;
    this.qKey[this.qCount] = key;
    this.qVel[this.qCount] = velocity;
    this.qFine[this.qCount] = fine;
    this.qCount++;
  }

  // One-shot: the bell rings out on its own, like a struck bell.
  noteOff(_noteId: number, _key: number, _release: number): void {}

  override allNotesOff(hard: boolean): void {
    this.qCount = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i]!;
      if (!v.active) continue;
      if (hard) v.active = false;
      else this.choke(v, 0.25);
    }
  }

  override reset(): void {
    this.qCount = 0;
    for (let i = 0; i < this.voices.length; i++) this.voices[i]!.active = false;
  }

  private choke(v: BellVoice, seconds: number): void {
    const step = 1 / Math.max(1, seconds * this.sampleRate);
    if (!v.choking || step > v.fadeStep) v.fadeStep = step;
    v.choking = true;
  }

  private start(key: number, vel: number, fine: number, p: ParamBlock<typeof params>, from: number): void {
    const sr = this.sampleRate;
    // Choke the same bell when re-struck, and keep the voice count down.
    let playing = 0;
    let oldest: BellVoice | null = null;
    for (let i = 0; i < this.voices.length; i++) {
      const o = this.voices[i]!;
      if (!o.active || o.choking) continue;
      if (o.key === key) {
        this.choke(o, 0.03);
        continue;
      }
      playing++;
      if (!oldest || o.age < oldest.age) oldest = o;
    }
    if (playing >= SOFT_LIMIT && oldest) this.choke(oldest, 0.03);

    let v: BellVoice | null = null;
    for (let i = 0; i < this.voices.length; i++) {
      const o = this.voices[i]!;
      if (!o.active) { v = o; break; }
    }
    if (!v) {
      for (let i = 0; i < this.voices.length; i++) {
        const o = this.voices[i]!;
        if (!v || (o.choking ? o.fade - 2 : o.age) < (v.choking ? v.fade - 2 : v.age)) v = o;
      }
    }
    if (!v) return;

    const f0 = mtof(key + (fine + at(this.pitch, from)) / 100);
    const decay = at(p.decay, from);
    const bright = at(p.brightness, from);
    const inh = at(p.inharmonic, from);
    const strike = at(p.strike, from);
    const sub = at(p.sub, from);
    const subDecay = at(p.subDecay, from);
    const width = at(p.width, from);
    const vs = at(p.velSens, from);
    const vg = 1 - vs + vs * vel;
    const fmax = sr * 0.45;
    let ff = Math.pow(220 / Math.max(20, f0), 0.25);
    if (ff < 0.5) ff = 0.5;
    if (ff > 1.5) ff = 1.5;

    for (let k = 0; k < NP; k++) {
      const rnd = this.host.rand() * 2 - 1;
      const spread = (0.0015 + inh * 0.008) * (k < 2 ? 0.3 : 1);
      const ratio = RATIOS[k]! * (1 + inh * DEV[k]!) * (1 + rnd * spread);
      const f = f0 * ratio;
      let bf = 1;
      if (k >= 2 && k <= 4) bf = 0.35 + 0.65 * bright;
      else if (k >= 5) bf = 1.4 * bright * bright;
      v.px[k] = 1;
      v.py[k] = 0;
      if (f >= fmax || f <= 0) {
        v.pe[k] = 0;
        v.pa[k] = 0;
        v.pd[k] = 0;
      } else {
        v.pe[k] = 2 * Math.sin((Math.PI * f) / sr);
        v.pa[k] = BASE[k]! * bf * vg;
        const t = Math.max(0.05, decay * DK[k]! * ff);
        v.pd[k] = Math.exp(-LN1000 / (t * sr));
      }
      const pan = Math.max(-1, Math.min(1, width * SPREAD[k]! * (0.8 + 0.4 * this.host.rand())));
      const ang = ((pan + 1) * Math.PI) / 4;
      v.pl[k] = Math.cos(ang) * Math.SQRT2;
      v.pr[k] = Math.sin(ang) * Math.SQRT2;
    }

    // Sub: a sine an octave down with a tiny pitch drop for punch.
    v.subPhase = 0;
    v.subInc = (f0 * 0.5) / sr;
    v.subAmp = sub * vg * 0.8;
    v.subMul = Math.exp(-LN1000 / (subDecay * sr));
    v.subBend = 1;
    v.subBendMul = Math.exp(-1 / (0.012 * sr));

    // Strike: band-passed noise burst.
    v.nAmp = strike * vg * 1.5;
    v.nMul = Math.exp(-LN1000 / (0.025 * sr));
    v.ic1 = 0;
    v.ic2 = 0;
    const fc = Math.min(sr * 0.4, Math.max(1500, f0 * 5));
    const g = Math.tan((Math.PI * fc) / sr);
    const kq = 1 / 1.2;
    v.a1 = 1 / (1 + g * (g + kq));
    v.a2 = g * v.a1;
    v.a3 = g * v.a2;

    // Strike: fast pitch-dropping click.
    v.cPhase = 0;
    v.cAmp = strike * vg * 0.6;
    v.cMul = Math.exp(-LN1000 / (0.012 * sr));
    v.cBase = Math.min(fmax, f0 * 2);
    v.cExtra = Math.max(0, Math.min(6000, fmax) - v.cBase);
    v.cDropMul = Math.exp(-1 / (0.003 * sr));

    v.key = key;
    v.fade = 1;
    v.fadeStep = 0;
    v.choking = false;
    v.active = true;
    v.age = this.counter++;
  }

  render(out: Float32Array[], from: number, to: number, p: ParamBlock<typeof params>): void {
    for (let q = 0; q < this.qCount; q++) this.start(this.qKey[q]!, this.qVel[q]!, this.qFine[q]!, p, from);
    this.qCount = 0;

    const L = out[0]!;
    const R = out[1] ?? L;
    const sr = this.sampleRate;
    const voices = this.voices;

    for (let i = from; i < to; i++) {
      let sumL = 0;
      let sumR = 0;
      for (let n = 0; n < voices.length; n++) {
        const v = voices[n]!;
        if (!v.active) continue;
        let l = 0;
        let r = 0;
        const px = v.px, py = v.py, pe = v.pe, pa = v.pa, pd = v.pd, pl = v.pl, pr = v.pr;
        for (let k = 0; k < NP; k++) {
          const a = pa[k]!;
          if (a < 1e-7) continue;
          const e = pe[k]!;
          const x = px[k]! - e * py[k]!;
          const y = py[k]! + e * x;
          px[k] = x;
          py[k] = y;
          const s = a * y;
          l += s * pl[k]!;
          r += s * pr[k]!;
          pa[k] = a * pd[k]!;
        }
        let mono = 0;
        if (v.subAmp > 1e-7) {
          v.subPhase += v.subInc * (1 + 0.6 * v.subBend);
          if (v.subPhase >= 1) v.subPhase -= 1;
          v.subBend *= v.subBendMul;
          mono += v.subAmp * Math.sin(TWO_PI * v.subPhase);
          v.subAmp *= v.subMul;
        }
        if (v.nAmp > 1e-6) {
          const w = this.noise();
          const v3 = w - v.ic2;
          const v1 = v.a1 * v.ic1 + v.a2 * v3;
          const v2 = v.ic2 + v.a2 * v.ic1 + v.a3 * v3;
          v.ic1 = 2 * v1 - v.ic1;
          v.ic2 = 2 * v2 - v.ic2;
          mono += v.nAmp * v1;
          v.nAmp *= v.nMul;
        } else if (v.nAmp !== 0) {
          v.nAmp = 0;
          v.ic1 = 0;
          v.ic2 = 0;
        }
        if (v.cAmp > 1e-6) {
          v.cPhase += (v.cBase + v.cExtra) / sr;
          if (v.cPhase >= 1) v.cPhase -= 1;
          v.cExtra *= v.cDropMul;
          mono += v.cAmp * Math.sin(TWO_PI * v.cPhase);
          v.cAmp *= v.cMul;
        }
        const f = v.fade;
        sumL += (l * 0.2 + mono) * f;
        sumR += (r * 0.2 + mono) * f;
        if (v.choking) {
          v.fade -= v.fadeStep;
          if (v.fade <= 0) v.active = false;
        }
      }
      const drv = at(p.drive, i);
      const g = 1 + drv * 5;
      const norm = 1 / Math.sqrt(g);
      const lvl = dbToGain(at(p.level, i));
      L[i]! += Math.tanh(sumL * g) * norm * lvl;
      if (R !== L) R[i]! += Math.tanh(sumR * g) * norm * lvl;
    }

    // Free voices that have rung out.
    for (let n = 0; n < voices.length; n++) {
      const v = voices[n]!;
      if (!v.active) continue;
      let total = v.subAmp + v.nAmp + v.cAmp;
      for (let k = 0; k < NP; k++) total += v.pa[k]! * 0.2;
      if (total < 1e-5) v.active = false;
    }
  }
}

registerKernel(ID, params, YeatBell);
