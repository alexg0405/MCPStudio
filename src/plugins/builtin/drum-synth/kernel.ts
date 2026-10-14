import {
  at,
  Clap,
  dbToGain,
  HiHat,
  InstrumentKernel,
  Kick,
  Perc,
  Snare,
  Tom,
  type DrumModel,
  type KernelHost,
  type ParamBlock,
} from '@agstudio/sdk/worklet';
import { TOM_KEYS, type DrumSynthParams } from './params';

const KICK = 0;
const PERC = 1;
const SNARE = 2;
const CLAP = 3;
const CHAT = 4;
const TOM = 5;
const OHAT = 6;

/** Which model each key plays (−1: none). General MIDI drum map. */
const KEY_MODEL = new Int8Array(128).fill(-1);
for (const k of [35, 36]) KEY_MODEL[k] = KICK;
KEY_MODEL[37] = PERC;
for (const k of [38, 40]) KEY_MODEL[k] = SNARE;
KEY_MODEL[39] = CLAP;
for (const k of [42, 44]) KEY_MODEL[k] = CHAT;
for (const k of Object.keys(TOM_KEYS)) KEY_MODEL[Number(k)] = TOM;
KEY_MODEL[46] = OHAT;

/** One voice: a drum model and where it sits in the stereo field. */
class Slot<V extends DrumModel> {
  gl = 0;
  gr = 0;
  age = 0;
  constructor(readonly model: V) {}
}

const MAX_PENDING = 64;

/**
 * Seven synthesized drums on the General MIDI keys (36 kick, 37 perc, 38 snare, 39 clap, 42 closed
 * hat, 45 tom, 46 open hat, plus 35, 40, 44 and the other tom keys). Every hit is one-shot: note
 * lengths don't matter. Note starts are queued and set up at the start of the next render, where
 * the block's param values are known, so even the first note of an export sounds as set.
 */
export class DrumSynthKernel extends InstrumentKernel<DrumSynthParams> {
  private readonly kicks: Slot<Kick>[];
  private readonly percs: Slot<Perc>[];
  private readonly snares: Slot<Snare>[];
  private readonly claps: Slot<Clap>[];
  private readonly closed: Slot<HiHat>[];
  private readonly toms: Slot<Tom>[];
  private readonly open: Slot<HiHat>[];
  private clock = 0;
  private readonly pendKey = new Int32Array(MAX_PENDING);
  private readonly pendVel = new Float32Array(MAX_PENDING);
  private readonly pendPan = new Float32Array(MAX_PENDING);
  private pending = 0;
  /** Every voice (for panic and reset). */
  private readonly all: Slot<DrumModel>[];

  constructor(host: KernelHost) {
    super(host);
    const sr = host.sampleRate;
    const pool = <V extends DrumModel>(n: number, make: (seed: number) => V, seed: number) =>
      Array.from({ length: n }, (_, i) => new Slot(make(seed + i * 101)));
    this.kicks = pool(2, (s) => new Kick(sr, s), 11);
    this.percs = pool(3, (s) => new Perc(sr, s), 23);
    this.snares = pool(3, (s) => new Snare(sr, s), 37);
    this.claps = pool(2, (s) => new Clap(sr, s), 41);
    this.closed = pool(2, (s) => new HiHat(sr, s), 53);
    this.toms = pool(4, (s) => new Tom(sr, s), 67);
    this.open = pool(2, (s) => new HiHat(sr, s), 79);
    this.all = [this.kicks, this.percs, this.snares, this.claps, this.closed, this.toms, this.open].flat();
  }

  noteOn(key: number, velocity: number, _noteId: number, pan: number, _fine = 0): void {
    if ((KEY_MODEL[key] ?? -1) < 0 || this.pending >= MAX_PENDING) return;
    this.pendKey[this.pending] = key;
    this.pendVel[this.pending] = velocity;
    this.pendPan[this.pending] = pan;
    this.pending++;
  }

  /** Drums are one-shots: releasing a key doesn't stop the hit. */
  noteOff(_noteId: number, _key: number, _release: number): void {}

  override allNotesOff(hard: boolean): void {
    this.pending = 0;
    if (hard) for (let s = 0; s < this.all.length; s++) (this.all[s] as Slot<DrumModel>).model.choke();
  }

  override reset(): void {
    this.pending = 0;
    for (let s = 0; s < this.all.length; s++) (this.all[s] as Slot<DrumModel>).model.reset();
  }

  render(out: Float32Array[], from: number, to: number, p: ParamBlock<DrumSynthParams>): void {
    if (this.pending > 0) this.startPending(p, from);
    const master = dbToGain(at(p.level, from));
    this.mix(this.kicks, out, from, to, master * dbToGain(at(p.kickLevel, from)));
    this.mix(this.percs, out, from, to, master * dbToGain(at(p.percLevel, from)));
    this.mix(this.snares, out, from, to, master * dbToGain(at(p.snareLevel, from)));
    this.mix(this.claps, out, from, to, master * dbToGain(at(p.clapLevel, from)));
    this.mix(this.closed, out, from, to, master * dbToGain(at(p.chatLevel, from)));
    this.mix(this.toms, out, from, to, master * dbToGain(at(p.tomLevel, from)));
    this.mix(this.open, out, from, to, master * dbToGain(at(p.ohatLevel, from)));
  }

  private mix<V extends DrumModel>(slots: Slot<V>[], out: Float32Array[], from: number, to: number, gain: number) {
    const L = out[0] as Float32Array;
    const R = (out[1] ?? out[0]) as Float32Array;
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s] as Slot<V>;
      const m = slot.model;
      if (!m.active) continue;
      const gl = slot.gl * gain;
      const gr = slot.gr * gain;
      for (let i = from; i < to; i++) {
        const y = m.next();
        L[i] = (L[i] as number) + y * gl;
        R[i] = (R[i] as number) + y * gr;
      }
    }
  }

  private startPending(p: ParamBlock<DrumSynthParams>, i: number): void {
    const sens = at(p.velocity, i);
    for (let n = 0; n < this.pending; n++) {
      const key = this.pendKey[n] as number;
      const vel = 1 - sens + sens * (this.pendVel[n] as number);
      this.start(KEY_MODEL[key] as number, key, vel, this.pendPan[n] as number, p, i);
    }
    this.pending = 0;
  }

  private start(model: number, key: number, vel: number, pan: number, p: ParamBlock<DrumSynthParams>, i: number) {
    switch (model) {
      case KICK: {
        const s = this.pick(this.kicks);
        const k = s.model;
        k.pitch = at(p.kickPitch, i);
        k.sweep = at(p.kickSweep, i);
        k.sweepTime = at(p.kickSweepTime, i) / 1000;
        k.decay = at(p.kickDecay, i);
        k.click = at(p.kickClick, i);
        k.drive = at(p.kickDrive, i);
        this.place(s, at(p.kickPan, i) + pan);
        k.trigger(vel);
        break;
      }
      case PERC: {
        const s = this.pick(this.percs);
        const m = s.model;
        m.pitch = at(p.percPitch, i);
        m.ring = at(p.percRing, i);
        m.decay = at(p.percDecay, i);
        m.noiseMix = at(p.percNoise, i);
        this.place(s, at(p.percPan, i) + pan);
        m.trigger(vel);
        break;
      }
      case SNARE: {
        const s = this.pick(this.snares);
        const m = s.model;
        m.tone = at(p.snareTone, i);
        m.snappy = at(p.snareSnappy, i);
        m.decay = at(p.snareDecay, i);
        m.brightness = at(p.snareBright, i);
        this.place(s, at(p.snarePan, i) + pan);
        m.trigger(vel);
        break;
      }
      case CLAP: {
        const s = this.pick(this.claps);
        const m = s.model;
        m.tone = at(p.clapTone, i);
        m.decay = at(p.clapDecay, i);
        m.spread = at(p.clapSpread, i) / 1000;
        this.place(s, at(p.clapPan, i) + pan);
        m.trigger(vel);
        break;
      }
      case CHAT:
      case OHAT: {
        if (at(p.hatChoke, i) >= 0.5)
          for (let o = 0; o < this.open.length; o++) (this.open[o] as Slot<HiHat>).model.choke();
        const closed = model === CHAT;
        const s = this.pick(closed ? this.closed : this.open);
        const m = s.model;
        m.decay = closed ? at(p.chatDecay, i) : at(p.ohatDecay, i);
        m.tone = closed ? at(p.chatTone, i) : at(p.ohatTone, i);
        m.noiseMix = closed ? 0.25 : 0.32;
        // The pedal hat (44) is a shorter, darker closed hat.
        if (key === 44) {
          m.decay *= 0.6;
          m.tone *= 0.7;
        }
        this.place(s, (closed ? at(p.chatPan, i) : at(p.ohatPan, i)) + pan);
        m.trigger(vel);
        break;
      }
      case TOM: {
        const s = this.pick(this.toms);
        const m = s.model;
        m.pitch = at(p.tomPitch, i) * Math.pow(2, (TOM_KEYS[key] ?? 0) / 12);
        m.sweep = at(p.tomSweep, i);
        m.decay = at(p.tomDecay, i);
        this.place(s, at(p.tomPan, i) + pan);
        m.trigger(vel);
        break;
      }
    }
  }

  /** A free voice of the pool, else the oldest one. */
  private pick<V extends DrumModel>(slots: Slot<V>[]): Slot<V> {
    let pick = slots[0] as Slot<V>;
    for (let s = 0; s < slots.length; s++) {
      const slot = slots[s] as Slot<V>;
      if (!slot.model.active) {
        pick = slot;
        break;
      }
      if (slot.age < pick.age) pick = slot;
    }
    pick.age = ++this.clock;
    return pick;
  }

  /** Constant-power pan. */
  private place(slot: Slot<DrumModel>, pan: number): void {
    const x = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    slot.gl = Math.sqrt(0.5 * (1 - x));
    slot.gr = Math.sqrt(0.5 * (1 + x));
  }
}
