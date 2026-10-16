/**
 * The DJ deck's player, pure DSP (no DOM, no Web Audio): it plays a song held in memory from a fractional
 * position at a smoothed speed, so one object does everything a deck needs.
 *
 *  - Turntable playback: the position advances by the speed each output frame and the song is read with
 *    4-point cubic (Hermite) interpolation, so a faster deck is also higher, like a record. At exactly 1× it
 *    is a sample-exact copy.
 *  - Key lock: the same speed as a tempo only, by a streaming WSOLA (waveform-similarity overlap-add): frames
 *    of 2048 samples, Hann-windowed, overlapped by half, each taken near where the tempo says it should come
 *    from and moved (±448 samples) to where it best continues the frame before, so the pitch holds. The
 *    nominal position keeps counting at the tempo, which is what sync and the loop read.
 *  - Loops: when the position crosses the loop end it moves back by the loop length (a fraction of a sample
 *    kept), and reads past the end continue from the loop start, so the seam is sample-accurate and seamless.
 *  - Jumps, starts and stops fade over 2 ms (the old sound's tail is rendered forward and faded out, the
 *    new one fades in), so a cue or a pause never clicks.
 *  - Scratch: the speed follows what the platter does (any speed, backwards too); nudge bends the tempo for a
 *    moment; the speed always glides.
 *  - Sync: a follower reads its master's published position and speed (shared memory) and holds the same tempo
 *    and beat phase by itself, every render quantum, so it never drifts and needs no messages.
 *
 * No allocation in `process()`. The worklet (`deck.worklet.ts`) is the thin shell around it.
 */
import { DS } from './deck-id';
import type { SyncSpec } from './deck-id';

/** Stretch frame, hop (half a frame), how far a frame may move to match the one before, search decimation. */
const N = 2048;
const H = N / 2;
const S = 448;
const DEC = 4;
const R = 2 * S + N;
/** The region of the song a frame's search reads, and the shorter arrays of the coarse search. */
const RD = R / DEC;
const TD = H / DEC;
/** How far from the nominal place a frame's best match may sit before it costs (correlation points per full range). */
const CENTER_BIAS = 0.03;

const HANN = new Float32Array(N);
const START_WINDOW = new Float32Array(N);
for (let j = 0; j < N; j++) {
  HANN[j] = 0.5 * (1 - Math.cos((2 * Math.PI * j) / N));
  START_WINDOW[j] = j < H ? 1 : (HANN[j] as number);
}

const MAX_TRIM = 0.02;
/** Seconds a follower takes to close a beat-phase error. */
const SYNC_TAU = 1.5;
/** A nudge ends this long after the last one. */
const NUDGE_HOLD_SEC = 0.12;

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

interface SyncState {
  spec: SyncSpec;
  state: Float64Array;
  seq: Int32Array;
}

/** What a deck publishes (see `DS`). */
export interface DeckSnapshot {
  pos: number;
  frame: number;
  rate: number;
  tempoRate: number;
  playing: boolean;
  scratching: boolean;
  loopWraps: number;
  syncError: number;
  syncLocked: boolean;
}

/** Reads a published state consistently (the writer may be mid-update). */
export function readDeckState(state: Float64Array, seq: Int32Array, out: DeckSnapshot): void {
  for (let tries = 0; tries < 8; tries++) {
    const a = Atomics.load(seq, 0);
    out.pos = state[DS.pos] as number;
    out.frame = state[DS.frame] as number;
    out.rate = state[DS.rate] as number;
    out.tempoRate = state[DS.tempoRate] as number;
    out.playing = state[DS.playing] === 1;
    out.scratching = state[DS.scratching] === 1;
    out.loopWraps = state[DS.loopWraps] as number;
    out.syncError = state[DS.syncError] as number;
    out.syncLocked = state[DS.syncLocked] === 1;
    if ((a & 1) === 0 && Atomics.load(seq, 0) === a) return;
  }
}

export const newSnapshot = (): DeckSnapshot => ({
  pos: 0,
  frame: 0,
  rate: 0,
  tempoRate: 0,
  playing: false,
  scratching: false,
  loopWraps: 0,
  syncError: 0,
  syncLocked: false,
});

export class DeckKernel {
  private chL: Float32Array | null = null;
  private chR: Float32Array | null = null;
  private frames = 0;

  /** Where the deck is (frames, nominal: the stretch's frames sit within ±448 of it). */
  pos = 0;
  playing = false;
  private tempo = 1;
  private keyLock = false;
  private nudgeTarget = 0;
  private nudgeCur = 0;
  private nudgeAge = 0;
  private scratching = false;
  private scratchTarget = 0;
  /** The speed in use (smoothed). */
  private rateOut = 1;
  private spinUp = 0;
  private tempoEff = 1;

  private loopStart = 0;
  private loopLen = 0;
  private loopStartI = 0;
  private loopLenI = 1;
  private loopEndI = 0;
  loopWraps = 0;

  private sync: SyncState | null = null;
  private syncError = 0;
  private syncLocked = false;
  /** Jump to the master's beat at the next quantum (a start, a sync press, the master jumped). */
  private alignPending = false;
  /** Frames a pending align waits for a master that isn't playing yet (a follower started together with it). */
  private alignWait = 0;
  /** Set when the deck starts from nothing, until its first frame is out. */
  private fresh = false;
  private readonly snap = newSnapshot();

  private shared: Float64Array | null = null;
  private seq: Int32Array | null = null;
  onEnded: (() => void) | null = null;

  // Fades.
  private readonly declick: number;
  private readonly tailL: Float32Array;
  private readonly tailR: Float32Array;
  private readonly keepL: Float32Array;
  private readonly keepR: Float32Array;
  private tailLen = 0;
  private tailAt = 0;
  private rise = 0;
  private stretchMode = false;

  // Rates of the smoothing.
  private readonly aNorm: number;
  private readonly aFast: number;
  private readonly aSlow: number;
  private readonly aNudge: number;

  // Stretch state.
  private readonly accL = new Float32Array(N);
  private readonly accR = new Float32Array(N);
  private readonly fifoL = new Float32Array(H);
  private readonly fifoR = new Float32Array(H);
  private fifoPos = H;
  private hasPrev = false;
  private prevC = 0;
  private readonly regL = new Float32Array(R);
  private readonly regR = new Float32Array(R);
  private readonly mf = new Float32Array(R);
  private readonly md = new Float32Array(RD);
  private readonly tL = new Float32Array(H);
  private readonly tR = new Float32Array(H);
  private readonly tf = new Float32Array(H);
  private readonly td = new Float32Array(TD);
  /** The sample the stretch (or the interpolator) produced last. */
  private sL = 0;
  private sR = 0;

  constructor(readonly sampleRate: number) {
    this.declick = Math.max(8, Math.round(0.002 * sampleRate));
    this.tailL = new Float32Array(this.declick);
    this.tailR = new Float32Array(this.declick);
    this.keepL = new Float32Array(this.declick);
    this.keepR = new Float32Array(this.declick);
    const a = (sec: number) => 1 - Math.exp(-1 / (sec * sampleRate));
    this.aNorm = a(0.006);
    this.aFast = a(0.003);
    this.aSlow = a(0.03);
    this.aNudge = a(0.008);
  }

  // ---- Wiring ----

  /** Where the deck publishes its state (the main thread and followers read it). */
  attachState(state: Float64Array, seq: Int32Array): void {
    this.shared = state;
    this.seq = seq;
  }

  setSong(channels: readonly Float32Array[] | null, frames = 0): void {
    this.captureTail();
    if (!channels || channels.length === 0 || frames <= 0) {
      this.chL = this.chR = null;
      this.frames = 0;
    } else {
      this.chL = channels[0] as Float32Array;
      this.chR = (channels[1] ?? channels[0]) as Float32Array;
      this.frames = Math.min(frames, this.chL.length);
    }
    this.playing = false;
    this.scratching = false;
    this.pos = 0;
    this.loopLen = 0;
    this.resetStretch();
    this.tailLen = 0;
  }

  get hasSong(): boolean {
    return this.chL !== null;
  }

  get songFrames(): number {
    return this.frames;
  }

  get isRunning(): boolean {
    return this.playing || this.scratching;
  }

  // ---- Commands ----

  play(on: boolean): void {
    if (!this.chL || on === this.playing) return;
    if (on) {
      if (this.pos >= this.frames) this.pos = 0;
      this.playing = true;
      if (!this.scratching) {
        this.rateOut = (this.sync && this.syncLocked ? this.tempoEff : this.tempo) * (1 + this.nudgeCur);
        this.startFresh();
      }
      // A follower starts on the master's beat.
      if (this.sync) this.requestAlign();
    } else {
      if (!this.scratching) this.captureTail();
      this.playing = false;
    }
  }

  /** Jumps to `pos` (frames), fading over a couple of milliseconds when the deck is sounding. */
  seek(pos: number): void {
    if (!this.chL) return;
    if (this.isRunning) this.captureTail();
    this.pos = clamp(pos, 0, this.frames);
    this.resetStretch();
    if (this.isRunning) this.rise = this.declick;
  }

  setTempo(rate: number, keyLock: boolean): void {
    this.tempo = clamp(Number.isFinite(rate) ? rate : 1, 0.25, 4);
    this.keyLock = keyLock;
  }

  nudge(bend: number): void {
    this.nudgeTarget = clamp(bend, -0.5, 0.5);
    this.nudgeAge = 0;
  }

  setScratching(on: boolean): void {
    if (on === this.scratching) return;
    if (on) {
      this.scratching = true;
      // Held where it is: a paused deck starts at rest, a playing one slows from the speed it had.
      if (!this.playing) this.rateOut = 0;
      this.scratchTarget = 0;
      if (this.chL) this.rise = this.declick;
      if (!this.playing) this.resetStretch();
    } else {
      this.scratching = false;
      if (this.playing) this.spinUp = Math.round(0.25 * this.sampleRate);
      else {
        this.captureTail();
        this.rateOut = 0;
      }
    }
  }

  setScratchRate(rate: number): void {
    this.scratchTarget = clamp(Number.isFinite(rate) ? rate : 0, -24, 24);
  }

  /** A loop of `length` frames from `start` (positions that are on or past the end wrap into it). */
  setLoop(start: number, length: number): void {
    if (!(length > 0) || !this.chL) {
      this.loopLen = 0;
      return;
    }
    this.loopStart = clamp(start, 0, this.frames);
    this.loopLen = Math.min(length, this.frames - this.loopStart);
    this.loopStartI = Math.round(this.loopStart);
    this.loopLenI = Math.max(1, Math.round(this.loopLen));
    this.loopEndI = this.loopStartI + this.loopLenI;
    if (this.pos >= this.loopStart + this.loopLen) {
      if (this.isRunning) this.captureTail();
      this.pos = this.loopStart + ((this.pos - this.loopStart) % this.loopLen);
      this.resetStretch();
      if (this.isRunning) this.rise = this.declick;
    }
  }

  clearLoop(): void {
    this.loopLen = 0;
  }

  get looping(): boolean {
    return this.loopLen > 0;
  }

  /** Moves a following deck to the master's beat at the next render quantum (it does so by itself when it starts). */
  align(): void {
    if (this.sync) this.requestAlign();
  }

  private requestAlign(): void {
    this.alignPending = true;
    this.alignWait = Math.round(0.15 * this.sampleRate);
  }

  setSync(spec: SyncSpec | null): void {
    if (!spec) {
      this.sync = null;
      this.syncLocked = false;
      this.syncError = 0;
      return;
    }
    this.alignPending = false;
    this.sync = {
      spec,
      state: new Float64Array(spec.master),
      seq: new Int32Array(spec.master, 0, 1),
    };
  }

  // ---- Rendering ----

  /** Renders `n` frames into outL/outR. `frame` is the context frame of the first one. */
  process(outL: Float32Array, outR: Float32Array, n: number, frame: number): void {
    this.updateSync(frame, n);
    this.publish(frame);
    if (!this.chL) {
      for (let i = 0; i < n; i++) {
        outL[i] = 0;
        outR[i] = 0;
      }
      return;
    }
    // Keeping a key-locked deck's mode follows the keylock switch and the scratch.
    const wantStretch = this.keyLock && !this.scratching;
    if (wantStretch !== this.stretchMode) {
      if (this.isRunning) {
        this.captureTail();
        this.rise = this.declick;
      }
      this.stretchMode = wantStretch;
      this.resetStretch();
    }
    this.nudgeAge += n;
    if (this.nudgeAge > NUDGE_HOLD_SEC * this.sampleRate) this.nudgeTarget = 0;
    const declick = this.declick;
    let running = this.isRunning;
    for (let i = 0; i < n; i++) {
      let l = 0;
      let r = 0;
      if (this.tailAt < this.tailLen) {
        l = this.tailL[this.tailAt] as number;
        r = this.tailR[this.tailAt] as number;
        this.tailAt++;
      }
      this.nudgeCur += (this.nudgeTarget - this.nudgeCur) * this.aNudge;
      if (running) {
        // The speed glides toward what the platter or the tempo asks for.
        let target: number;
        let a: number;
        if (this.scratching) {
          target = this.scratchTarget;
          a = this.aFast;
        } else {
          target = this.tempoEff * (1 + this.nudgeCur);
          if (this.spinUp > 0) {
            a = this.aSlow;
            this.spinUp--;
          } else a = this.aNorm;
        }
        this.rateOut += (target - this.rateOut) * a;
        const rate = this.rateOut;

        if (this.stretchMode) {
          if (this.fifoPos >= H) this.computeFrame();
          this.sL = this.fifoL[this.fifoPos] as number;
          this.sR = this.fifoR[this.fifoPos] as number;
          this.fifoPos++;
        } else {
          this.sL = this.interp(this.chL, this.pos);
          this.sR = this.chR === this.chL ? this.sL : this.interp(this.chR as Float32Array, this.pos);
        }
        if (this.rise > 0) {
          const g = 1 - this.rise / declick;
          this.rise--;
          l += this.sL * g;
          r += this.sR * g;
        } else {
          l += this.sL;
          r += this.sR;
        }

        this.fresh = false;
        this.pos += rate;
        if (this.loopLen > 0) {
          const end = this.loopStart + this.loopLen;
          if (rate > 0 && this.pos >= end) {
            this.pos -= this.loopLen;
            if (this.pos >= end) this.pos = this.loopStart + ((this.pos - this.loopStart) % this.loopLen);
            this.loopWraps++;
          } else if (rate < 0 && this.pos < this.loopStart) {
            this.pos += this.loopLen;
          }
        }
        if (this.pos >= this.frames) {
          // The end of the song: the last bit rings out through the tail, then it stops.
          this.pos = this.frames;
          this.captureTail();
          this.playing = false;
          this.scratching = false;
          running = false;
          this.onEnded?.();
        } else if (this.pos < 0) {
          this.pos = 0;
          if (this.scratching) this.rateOut = 0;
        }
      }
      outL[i] = l;
      outR[i] = r;
    }
  }

  // ---- Internals ----

  /** Starts sounding at the current position from nothing (play, a seek while stopped). */
  private startFresh(): void {
    this.fresh = true;
    this.resetStretch();
    this.rise = this.declick;
    this.stretchMode = this.keyLock && !this.scratching;
  }

  private resetStretch(): void {
    this.fifoPos = H;
    this.hasPrev = false;
    this.accL.fill(0);
    this.accR.fill(0);
  }

  /** Renders the next 2 ms of what is sounding, faded out, so a jump or a stop can play it under the new sound. */
  private captureTail(): void {
    if (!this.chL || !this.isRunning) {
      this.tailLen = 0;
      this.tailAt = 0;
      return;
    }
    const d = this.declick;
    // What the new sound doesn't replace yet keeps playing: whatever is left of an older tail first.
    const left = this.tailLen - this.tailAt;
    for (let k = 0; k < left; k++) {
      this.keepL[k] = this.tailL[this.tailAt + k] as number;
      this.keepR[k] = this.tailR[this.tailAt + k] as number;
    }
    if (this.stretchMode) {
      // The finished samples first, then the half-frame still waiting to be overlapped.
      let k = 0;
      for (let f = this.fifoPos; f < H && k < d; f++, k++) {
        this.tailL[k] = this.fifoL[f] as number;
        this.tailR[k] = this.fifoR[f] as number;
      }
      for (let j = 0; k < d; j++, k++) {
        this.tailL[k] = this.accL[j] as number;
        this.tailR[k] = this.accR[j] as number;
      }
    } else {
      let p = this.pos;
      let rate = this.rateOut;
      for (let k = 0; k < d; k++) {
        this.tailL[k] = this.interp(this.chL, p);
        this.tailR[k] = this.chR === this.chL ? (this.tailL[k] as number) : this.interp(this.chR as Float32Array, p);
        p += rate;
        if (this.loopLen > 0 && rate > 0 && p >= this.loopStart + this.loopLen) p -= this.loopLen;
        if (p < 0 || p >= this.frames) rate = 0;
      }
    }
    for (let k = 0; k < d; k++) {
      const g = 1 - (k + 1) / d;
      this.tailL[k] = (this.tailL[k] as number) * g + (k < left ? (this.keepL[k] as number) : 0);
      this.tailR[k] = (this.tailR[k] as number) * g + (k < left ? (this.keepR[k] as number) : 0);
    }
    this.tailLen = d;
    this.tailAt = 0;
  }

  private at(ch: Float32Array, i: number): number {
    if (this.loopLen > 0 && i >= this.loopEndI) i = this.loopStartI + ((i - this.loopStartI) % this.loopLenI);
    return i >= 0 && i < this.frames ? (ch[i] as number) : 0;
  }

  /** The song at a fractional position, cubic (Hermite) between the four nearest frames. */
  private interp(ch: Float32Array, pos: number): number {
    const i = Math.floor(pos);
    const f = pos - i;
    if (f === 0) return this.at(ch, i);
    const limit = this.loopLen > 0 ? this.loopEndI : this.frames;
    let y0: number;
    let y1: number;
    let y2: number;
    let y3: number;
    if (i >= 1 && i + 2 < limit) {
      y0 = ch[i - 1] as number;
      y1 = ch[i] as number;
      y2 = ch[i + 1] as number;
      y3 = ch[i + 2] as number;
    } else {
      y0 = this.at(ch, i - 1);
      y1 = this.at(ch, i);
      y2 = this.at(ch, i + 1);
      y3 = this.at(ch, i + 2);
    }
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }

  /** Copies `len` frames from `start` into dst (zeros outside the song; reads past a loop end continue from its start). */
  private readRange(dL: Float32Array, dR: Float32Array, start: number, len: number): void {
    const cl = this.chL as Float32Array;
    const cr = this.chR as Float32Array;
    let o = 0;
    let i = start;
    const looping = this.loopLen > 0;
    while (o < len) {
      let m = i;
      if (looping && m >= this.loopEndI) m = this.loopStartI + ((m - this.loopStartI) % this.loopLenI);
      if (m < 0) {
        const run = Math.min(len - o, -m);
        for (let k = 0; k < run; k++) {
          dL[o + k] = 0;
          dR[o + k] = 0;
        }
        o += run;
        i += run;
      } else if (m >= this.frames) {
        for (let k = o; k < len; k++) {
          dL[k] = 0;
          dR[k] = 0;
        }
        return;
      } else {
        const limit = looping && m < this.loopEndI ? this.loopEndI : this.frames;
        const run = Math.min(len - o, limit - m);
        for (let k = 0; k < run; k++) {
          dL[o + k] = cl[m + k] as number;
          dR[o + k] = cr[m + k] as number;
        }
        o += run;
        i += run;
      }
    }
  }

  /** One WSOLA frame: picks where in the song it comes from, overlap-adds it and refills the output hop. */
  private computeFrame(): void {
    const rate = clamp(this.rateOut, 0.5, 2);
    const first = !this.hasPrev;
    const s = first ? Math.round(this.pos) : Math.round(this.pos + rate * H - H);
    const r0 = s - S;
    this.readRange(this.regL, this.regR, r0, R);
    let k = S;
    if (!first) k = this.search();
    const win = first ? START_WINDOW : HANN;
    const accL = this.accL;
    const accR = this.accR;
    const regL = this.regL;
    const regR = this.regR;
    for (let j = 0; j < N; j++) {
      const w = win[j] as number;
      accL[j] = (accL[j] as number) + w * (regL[k + j] as number);
      accR[j] = (accR[j] as number) + w * (regR[k + j] as number);
    }
    this.prevC = r0 + k;
    if (this.loopLen > 0 && this.prevC >= this.loopEndI) this.prevC -= this.loopLenI;
    this.hasPrev = true;
    for (let j = 0; j < H; j++) {
      this.fifoL[j] = accL[j] as number;
      this.fifoR[j] = accR[j] as number;
    }
    accL.copyWithin(0, H, N);
    accR.copyWithin(0, H, N);
    accL.fill(0, H, N);
    accR.fill(0, H, N);
    this.fifoPos = 0;
  }

  /**
   * The offset in the region (0…2S, S = the nominal place) whose first half-frame best continues the frame before:
   * normalized cross-correlation with the part of the previous frame that is still to be heard, a coarse pass on
   * a 4× decimated mono mix, then ±4 frames at full rate, with a small cost for moving away from the middle.
   */
  private search(): number {
    this.readRange(this.tL, this.tR, this.prevC + H, H);
    const mf = this.mf;
    const md = this.md;
    const tf = this.tf;
    const td = this.td;
    const regL = this.regL;
    const regR = this.regR;
    for (let i = 0; i < R; i++) mf[i] = 0.5 * ((regL[i] as number) + (regR[i] as number));
    for (let m = 0; m < RD; m++) {
      const b = m * DEC;
      md[m] = 0.25 * ((mf[b] as number) + (mf[b + 1] as number) + (mf[b + 2] as number) + (mf[b + 3] as number));
    }
    for (let i = 0; i < H; i++) tf[i] = 0.5 * ((this.tL[i] as number) + (this.tR[i] as number));
    for (let m = 0; m < TD; m++) {
      const b = m * DEC;
      td[m] = 0.25 * ((tf[b] as number) + (tf[b + 1] as number) + (tf[b + 2] as number) + (tf[b + 3] as number));
    }
    let et = 1e-9;
    for (let i = 0; i < TD; i++) et += (td[i] as number) * (td[i] as number);
    // Coarse: candidates every 4 frames across the whole ±S range (the middle is S/4).
    const cands = (2 * S) / DEC + 1;
    let e = 1e-9;
    for (let i = 0; i < TD; i++) e += (md[i] as number) * (md[i] as number);
    let bestJ = S / DEC;
    let bestScore = -Infinity;
    const mid = S / DEC;
    for (let j = 0; j < cands; j++) {
      let c = 0;
      for (let i = 0; i < TD; i++) c += (td[i] as number) * (md[j + i] as number);
      const score = c / Math.sqrt(e * et) - (CENTER_BIAS * Math.abs(j - mid)) / mid;
      if (score > bestScore) {
        bestScore = score;
        bestJ = j;
      }
      const out = md[j] as number;
      const inn = md[j + TD] as number;
      e += inn * inn - out * out;
      if (e < 1e-9) e = 1e-9;
    }
    // Fine: ±4 frames around the coarse winner.
    let etf = 1e-9;
    for (let i = 0; i < H; i++) etf += (tf[i] as number) * (tf[i] as number);
    let best = bestJ * DEC;
    let bestFine = -Infinity;
    const lo = Math.max(0, bestJ * DEC - DEC);
    const hi = Math.min(2 * S, bestJ * DEC + DEC);
    for (let k = lo; k <= hi; k++) {
      let c = 0;
      let ec = 1e-9;
      for (let i = 0; i < H; i++) {
        const v = mf[k + i] as number;
        c += (tf[i] as number) * v;
        ec += v * v;
      }
      const score = c / Math.sqrt(ec * etf) - (CENTER_BIAS * Math.abs(k - S)) / S;
      if (score > bestFine) {
        bestFine = score;
        best = k;
      }
    }
    return best;
  }

  /** Follows the master's tempo and beat phase for this render quantum. */
  private updateSync(frame: number, n: number): void {
    const sy = this.sync;
    this.tempoEff = this.tempo;
    if (!sy) return;
    const snap = this.snap;
    readDeckState(sy.state, sy.seq, snap);
    if (!snap.playing || snap.tempoRate <= 0) {
      this.syncLocked = false;
      this.syncError = 0;
      // A follower started together with its master waits a moment for it to start.
      if (this.alignPending && (this.alignWait -= n) <= 0) this.alignPending = false;
      return;
    }
    const sp = sy.spec;
    this.tempoEff = sp.ratio * snap.tempoRate;
    this.syncLocked = true;
    if (!this.playing || snap.scratching) {
      this.syncError = 0;
      return;
    }
    // The master's position at the first frame of this quantum.
    const mp = snap.pos + (frame - snap.frame) * snap.rate;
    const phM = (mp - sp.masterFirst) / sp.masterBeat;
    const phS = (this.pos - sp.selfFirst) / sp.selfBeat;
    let err = phS - phM;
    err -= Math.round(err);
    this.syncError = err;
    if (this.alignPending) {
      this.alignPending = false;
      // The master may be mid-jump (its position is a quantum old): align only when it is steady is not
      // knowable here, so just land on its beat now; the phase lock does the rest.
      if (!this.fresh) this.captureTail();
      this.pos = clamp(this.pos - err * sp.selfBeat, 0, this.frames);
      this.resetStretch();
      if (this.isRunning) this.rise = this.declick;
      this.syncError = 0;
      return;
    }
    const secPerBeat = sp.selfBeat / (this.sampleRate * Math.max(0.1, this.rateOut));
    const trim = clamp((-err * secPerBeat) / SYNC_TAU, -MAX_TRIM, MAX_TRIM);
    this.tempoEff *= 1 + trim;
  }

  private publish(frame: number): void {
    const st = this.shared;
    const seq = this.seq;
    if (!st || !seq) return;
    Atomics.add(seq, 0, 1);
    st[DS.pos] = this.pos;
    st[DS.frame] = frame;
    const running = this.isRunning;
    st[DS.rate] = running ? this.rateOut : 0;
    st[DS.tempoRate] = this.playing ? this.tempoEff * (1 + this.nudgeCur) : 0;
    st[DS.playing] = running ? 1 : 0;
    st[DS.scratching] = this.scratching ? 1 : 0;
    st[DS.loopWraps] = this.loopWraps;
    st[DS.syncError] = this.syncError;
    st[DS.syncLocked] = this.syncLocked ? 1 : 0;
    Atomics.add(seq, 0, 1);
  }
}
