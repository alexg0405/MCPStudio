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
import { BeatMap } from '@core/dj/beat-map';
import { BLOCK_BITS as BLOCK_BITS_OF_ID, BLOCK_FRAMES as BLOCK_FRAMES_OF_ID, BLOCK_MASK as BLOCK_MASK_OF_ID, DS } from './deck-id';

// Constants of this file: an imported binding is read through the module object (in tests, in some bundles), which made
// the per-sample reads below 5× slower.
const BLOCK_BITS = BLOCK_BITS_OF_ID;
const BLOCK_FRAMES = BLOCK_FRAMES_OF_ID;
const BLOCK_MASK = BLOCK_MASK_OF_ID;
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

/** What `computeFrame` does with a frame (see `planTransient`). */
const KIND_NORMAL = 0;
const KIND_CONTINUE = 1;
const KIND_ENTER = 2;
/** The fraction of the lead (how far the heard input is from where the tempo puts it) that still stands after one more frame. */
const CARRY = 0.5;
/** The frame that starts a run around an attack may move this far (frames) to continue the one before: 1.3 ms at 48 kHz. */
const ENTRY_SEARCH = 64;
/** A run starts this many output frames before its attack: past the splice that starts it (H) and the attack's own lead-in. */
const RUN_LEAD = H + 320;
/** A run goes on until the next splice would begin this far (frames) after the attack: past its body and the search's reach. */
const RUN_TAIL = 930;
/** How far (output frames) a continued run may put an attack from where the tempo wants it: 2 ms at 48 kHz. */
const LAND_TOL = 96;
/** An attack this close (output frames) before a stronger one gives way to it (their runs could not both fit). */
const RUN_SPAN = RUN_LEAD + H + RUN_TAIL + H;
/** The most a run's first frame may jump from where the frame before leads on (frames). */
const MAX_JUMP = 1500;
/** The attack detector (the arrangement stretch's `detectOnsets`, run lazily): hops of mean-square energy per ~2.7 ms. */
const ENG_N = 1024;
const ON_PRE = 8;
const ON_POST = 4;
/** Mean square under which nothing counts as an attack (−60 dBFS). */
const ON_GATE = 1e-6;
const MAX_ON = 24;

const MAX_TRIM = 0.02;
/** Seconds a follower takes to close a beat-phase error. */
const SYNC_TAU = 1.5;
/** A nudge ends this long after the last one. */
const NUDGE_HOLD_SEC = 0.12;

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

function beatMapOf(beats: Float64Array | undefined, first: number): BeatMap | null {
  if (!beats || beats.length < 2) return null;
  try {
    return new BeatMap(beats, first);
  } catch {
    return null;
  }
}

interface SyncState {
  spec: SyncSpec;
  state: Float64Array;
  seq: Int32Array;
  /** The beat clocks of the two songs when they have tracked beats (null: the fixed grid in `spec`). */
  selfMap: BeatMap | null;
  masterMap: BeatMap | null;
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
  stalled: boolean;
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
    out.stalled = state[DS.stalled] === 1;
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
  stalled: false,
});

export class DeckKernel {
  /** The song's blocks: planar float32 in a pool (`BLOCK_FRAMES` per slot), found through `table` (see `BLOCK_BITS`). */
  private chL: Float32Array | null = null;
  private chR: Float32Array | null = null;
  private table: Int32Array = new Int32Array(0);
  private frames = 0;
  /** Where reads of the song stop being the plain blocks: the loop's end while one is on, else the song's. */
  private readLimit = 0;
  /** The pool holds a window of the song (some blocks may be missing): the player checks what it is about to read. */
  private windowed = false;
  /** Waiting for audio that isn't in the window yet: silent and not advancing until it is. */
  private stalled = false;
  /** How far ahead (frames) of the play position the audio must be there; twice that to leave a stall. */
  private readonly guard: number;

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

  // Transient preservation (see `computeFrame`).
  /** Off turns the attack handling off (a test compares with plain WSOLA). */
  transientsOn = true;
  private readonly onHop: number;
  private readonly engE = new Float64Array(ENG_N);
  private readonly engTag = new Int32Array(ENG_N).fill(-1);
  private readonly eL: Float32Array;
  private readonly eR: Float32Array;
  private readonly refL: Float32Array;
  private readonly refR: Float32Array;
  private readonly refTag = new Int32Array(64).fill(-1);
  private readonly refVal = new Float64Array(64);
  private readonly onC = new Float64Array(MAX_ON);
  private readonly onS = new Float64Array(MAX_ON);
  private onN = 0;
  /** The frame before was exact (the first, or inside a run around an attack): the next may continue it. */
  private cleanRun = false;
  /** Where the heard input is relative to where the tempo puts it after a run; closes by `CARRY` a frame. */
  private offCarry = 0;
  private planStart = 0;

  constructor(readonly sampleRate: number) {
    this.declick = Math.max(8, Math.round(0.002 * sampleRate));
    this.tailL = new Float32Array(this.declick);
    this.tailR = new Float32Array(this.declick);
    this.keepL = new Float32Array(this.declick);
    this.keepR = new Float32Array(this.declick);
    this.guard = Math.round(0.3 * sampleRate);
    this.onHop = Math.max(32, Math.round(sampleRate / 375));
    this.eL = new Float32Array(this.onHop);
    this.eR = new Float32Array(this.onHop);
    this.refL = new Float32Array((ON_POST + 2) * this.onHop);
    this.refR = new Float32Array((ON_POST + 2) * this.onHop);
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

  /** A song held whole in memory (planar float32, one array per channel). */
  setSong(channels: readonly Float32Array[] | null, frames = 0): void {
    if (!channels || channels.length === 0 || frames <= 0) {
      this.install(null, null, new Int32Array(0), 0, false);
      return;
    }
    const l = channels[0] as Float32Array;
    const n = Math.min(frames, l.length);
    // Every block is where it would be in one array: the identity table.
    const table = new Int32Array(Math.ceil(n / BLOCK_FRAMES));
    for (let b = 0; b < table.length; b++) table[b] = b;
    this.install(l, (channels[1] ?? l) as Float32Array, table, n, false);
  }

  /**
   * A song as a window of its blocks: `poolL`/`poolR` hold `slots × BLOCK_FRAMES` frames, `table[b]` is the slot of block
   * `b` or −1. The main thread fills the pool and the table ahead of the play position (`deck-stream.ts`); a jump
   * outside the window waits (silent, a 2 ms fade out and in) until its blocks have come.
   */
  setStream(poolL: Float32Array, poolR: Float32Array, table: Int32Array, frames: number): void {
    this.install(poolL, poolR, table, frames, true);
  }

  private install(l: Float32Array | null, r: Float32Array | null, table: Int32Array, frames: number, windowed: boolean): void {
    this.captureTail();
    this.chL = l;
    this.chR = r;
    this.table = table;
    this.frames = l ? frames : 0;
    this.readLimit = this.frames;
    this.windowed = windowed;
    this.stalled = false;
    this.playing = false;
    this.scratching = false;
    this.pos = 0;
    this.loopLen = 0;
    this.resetStretch();
    this.clearOnsetCache();
    this.tailLen = 0;
  }

  /** Whether the player is waiting for audio to arrive (see `setStream`). */
  get isStalled(): boolean {
    return this.stalled;
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
      this.readLimit = this.frames;
      this.clearOnsetCache();
      return;
    }
    this.clearOnsetCache();
    this.loopStart = clamp(start, 0, this.frames);
    this.loopLen = Math.min(length, this.frames - this.loopStart);
    this.loopStartI = Math.round(this.loopStart);
    this.loopLenI = Math.max(1, Math.round(this.loopLen));
    this.loopEndI = this.loopStartI + this.loopLenI;
    this.readLimit = this.loopEndI;
    if (this.pos >= this.loopStart + this.loopLen) {
      if (this.isRunning) this.captureTail();
      this.pos = this.loopStart + ((this.pos - this.loopStart) % this.loopLen);
      this.resetStretch();
      if (this.isRunning) this.rise = this.declick;
    }
  }

  clearLoop(): void {
    this.loopLen = 0;
    this.readLimit = this.frames;
    this.clearOnsetCache();
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
      selfMap: beatMapOf(spec.selfBeats, spec.selfFirst),
      masterMap: beatMapOf(spec.masterBeats, spec.masterFirst),
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
    if (this.windowed) this.checkWindow(n);
    const declick = this.declick;
    let running = this.isRunning && !this.stalled;
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

  /**
   * The audio a window holds must cover what the next render reads: the play position, a little behind (the stretch's
   * search) and well ahead (`guard`, so the sound fades out in time when the supply runs dry, never mid-sample). When it
   * doesn't (a jump to a part that hasn't been loaded, a decode that fell behind) the deck fades out over 2 ms and waits,
   * silent and not advancing, and fades back in once there is twice that much ahead of it.
   */
  private checkWindow(n: number): void {
    if (!this.isRunning) {
      this.stalled = false;
      return;
    }
    const ra = Math.min(4, Math.abs(this.rateOut) + 0.05);
    const lo = this.pos - (this.stretchMode ? 4096 : 16 + ra * n);
    const hi = this.pos + ra * (n + this.guard * (this.stalled ? 2 : 1)) + (this.stretchMode ? R + 4096 : 16);
    const ok = this.isResident(lo, hi);
    if (!this.stalled && !ok) {
      // What sounds now fades out over the next 2 ms (it is in the window: the check above looks ahead far enough).
      this.captureTail();
      this.stalled = true;
    } else if (this.stalled && ok) {
      this.stalled = false;
      this.resetStretch();
      this.rise = this.declick;
    }
  }

  /** Whether every block under frames [lo, hi) is in the window (loop seams followed). */
  private isResident(lo: number, hi: number): boolean {
    const a = Math.max(0, Math.floor(lo));
    const b = Math.min(this.frames, Math.ceil(hi));
    if (b <= a) return true;
    if (this.loopLen > 0 && b > this.loopEndI) {
      // Past the loop end the sound comes from its start.
      if (a < this.loopEndI && !this.blocksResident(a, this.loopEndI)) return false;
      return this.blocksResident(this.loopStartI, Math.min(this.loopEndI, this.loopStartI + b - Math.max(a, this.loopEndI)));
    }
    return this.blocksResident(a, b);
  }

  private blocksResident(a: number, b: number): boolean {
    for (let blk = a >>> BLOCK_BITS, last = (b - 1) >>> BLOCK_BITS; blk <= last; blk++) if (Atomics.load(this.table, blk) < 0) return false;
    return true;
  }

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
    if (i < 0 || i >= this.frames) return 0;
    const s = this.table[i >>> BLOCK_BITS] as number;
    return s < 0 ? 0 : (ch[(s << BLOCK_BITS) | (i & BLOCK_MASK)] as number);
  }

  /**
   * The song at a fractional position, cubic (Hermite) between the four nearest frames. The usual case, four frames in one
   * block that is there, is read straight (and small enough to be inlined into the render loop); the rest (a block
   * edge, a loop seam, the song's ends, a missing block) goes through `at`.
   */
  private interp(ch: Float32Array, pos: number): number {
    const i = Math.floor(pos);
    const f = pos - i;
    const b = (i - 1) >>> BLOCK_BITS;
    if (f !== 0 && i >= 1 && i + 2 < this.readLimit && b === (i + 2) >>> BLOCK_BITS) {
      const s = this.table[b] as number;
      if (s >= 0) {
        const o = (s << BLOCK_BITS) | ((i - 1) & BLOCK_MASK);
        const y0 = ch[o] as number;
        const y1 = ch[o + 1] as number;
        const y2 = ch[o + 2] as number;
        const y3 = ch[o + 3] as number;
        return (((0.5 * (y3 - y0) + 1.5 * (y1 - y2)) * f + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * f + 0.5 * (y2 - y0)) * f + y1;
      }
    }
    return this.interpSlow(ch, i, f);
  }

  private interpSlow(ch: Float32Array, i: number, f: number): number {
    if (f === 0) return this.at(ch, i);
    const y0 = this.at(ch, i - 1);
    const y1 = this.at(ch, i);
    const y2 = this.at(ch, i + 1);
    const y3 = this.at(ch, i + 2);
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }

  /** Copies `len` frames from `start` into dst (zeros outside the song and where the window has none; reads past a loop end continue from its start). */
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
        // The part of the run that is in this block.
        const run = Math.min(len - o, limit - m, BLOCK_FRAMES - (m & BLOCK_MASK));
        const slot = this.table[m >>> BLOCK_BITS] as number;
        if (slot < 0) {
          for (let k = 0; k < run; k++) {
            dL[o + k] = 0;
            dR[o + k] = 0;
          }
        } else {
          const base = (slot << BLOCK_BITS) | (m & BLOCK_MASK);
          for (let k = 0; k < run; k++) {
            dL[o + k] = cl[base + k] as number;
            dR[o + k] = cr[base + k] as number;
          }
        }
        o += run;
        i += run;
      }
    }
  }

  private clearOnsetCache(): void {
    this.engTag.fill(-1);
    this.refTag.fill(-1);
  }

  /** Mean square of the mono mix over hop `h` (frames h·hop…), cached by hop index; zero before the song. */
  private energy(h: number): number {
    if (h < 0) return 0;
    const i = h & (ENG_N - 1);
    if (this.engTag[i] === h) return this.engE[i] as number;
    const hop = this.onHop;
    this.readRange(this.eL, this.eR, h * hop, hop);
    let sum = 0;
    for (let j = 0; j < hop; j++) {
      const m = 0.5 * ((this.eL[j] as number) + (this.eR[j] as number));
      sum += m * m;
    }
    const e = sum / hop;
    this.engTag[i] = h;
    this.engE[i] = e;
    return e;
  }

  /** The first frame of an attack that the hop `h` is the strongest rise of: the first sample that reaches 30 % of its peak. */
  private refine(h: number): number {
    const hop = this.onHop;
    const a = (h - 1) * hop;
    const len = (ON_POST + 2) * hop;
    this.readRange(this.refL, this.refR, a, len);
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const m = Math.abs(0.5 * ((this.refL[i] as number) + (this.refR[i] as number)));
      if (m > peak) peak = m;
    }
    const thr = 0.3 * peak;
    let at = 0;
    while (at < len - 1 && Math.abs(0.5 * ((this.refL[at] as number) + (this.refR[at] as number))) < thr) at++;
    return a + at;
  }

  private addOnset(h: number, strength: number): void {
    if (this.onN >= MAX_ON) return;
    const slot = h & 63;
    let c: number;
    if (this.refTag[slot] === h) c = this.refVal[slot] as number;
    else {
      c = this.refine(h);
      this.refTag[slot] = h;
      this.refVal[slot] = c;
    }
    this.onC[this.onN] = c;
    this.onS[this.onN] = strength;
    this.onN++;
  }

  /**
   * The attacks between two song positions into `onC` (frame of the attack) and `onS` (how strong), ascending: hops where
   * the energy of the next ~10 ms is more than 8× that of the ~20 ms before, a run of such hops being one attack (its
   * strongest). The detector of the arrangement stretch (`detectOnsets`), but lazy and without a global gate, so the same
   * attack is found the same way from any frame that looks at it.
   */
  private scanOnsets(from: number, to: number): void {
    this.onN = 0;
    const hop = this.onHop;
    const h0 = Math.max(ON_PRE, Math.floor(from / hop) - 12);
    const h1 = Math.floor(to / hop);
    let runBest = -1;
    let runStrength = 0;
    for (let h = h0; h <= h1; h++) {
      let pre = 0;
      for (let j = 1; j <= ON_PRE; j++) pre += this.energy(h - j);
      pre /= ON_PRE;
      let post = 0;
      for (let j = 0; j < ON_POST; j++) post += this.energy(h + j);
      post /= ON_POST;
      if (post > ON_GATE && post > 8 * pre + 1e-12) {
        const st = Math.sqrt(post) - Math.sqrt(pre);
        if (st > runStrength) {
          runStrength = st;
          runBest = h;
        }
      } else if (runBest >= 0) {
        this.addOnset(runBest, runStrength);
        runBest = -1;
        runStrength = 0;
      }
    }
    if (runBest >= 0) this.addOnset(runBest, runStrength);
  }

  /**
   * Whether the next frame should continue the one before exactly (`KIND_CONTINUE`: inside a run around an attack),
   * start such a run (`KIND_ENTER`, placed so the attack lands on time, in `planStart`) or be an ordinary WSOLA frame.
   *
   * Everything is in input frames of the nominal lap (a loop's seam is unwrapped around the playhead) and output frames.
   * `sc` is where the previous frame leads on (what a frame that continues it starts at); a run keeps that, and the attack
   * `c` is then heard `c − sc` frames from now, against the `(c − pos)/rate` the tempo asks for.
   */
  private planTransient(rate: number): number {
    const pos = this.pos;
    let sc = this.prevC + H;
    if (this.loopLen > 0) {
      const len = this.loopLenI;
      if (sc - pos > len / 2) sc -= len;
      else if (sc - pos < -len / 2) sc += len;
    }
    const hop = this.onHop;
    this.scanOnsets(Math.min(sc, pos) - RUN_TAIL - 2 * hop, Math.max(sc, pos) + (RUN_LEAD + H + RUN_SPAN) * rate + 2 * hop);
    const n = this.onN;
    const onC = this.onC;
    if (this.cleanRun) {
      for (let i = 0; i < n; i++) {
        const c = onC[i] as number;
        const u = c - sc;
        if (u <= -RUN_TAIL) continue;
        if (u >= RUN_LEAD + H) break;
        // The next attack is within reach of the run: keep it going if the run puts it on time.
        if (Math.abs(u - (c - pos) / rate) <= LAND_TOL) {
          this.planStart = sc;
          return KIND_CONTINUE;
        }
        break;
      }
    }
    for (let i = 0; i < n; i++) {
      const c = onC[i] as number;
      const t = (c - pos) / rate;
      if (t < RUN_LEAD) continue;
      if (t >= RUN_LEAD + H) break;
      let blocked = false;
      for (let j = i + 1; j < n; j++) {
        if (((onC[j] as number) - c) / rate >= RUN_SPAN) break;
        if ((this.onS[j] as number) > (this.onS[i] as number)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const start = Math.round(c - t);
      if (Math.abs(start - sc) > MAX_JUMP) continue;
      this.planStart = start;
      return KIND_ENTER;
    }
    return KIND_NORMAL;
  }

  /**
   * One WSOLA frame: picks where in the song it comes from, overlap-adds it and refills the output hop.
   *
   * A frame normally comes from where the tempo says its centre is and moves (±S) to where it best continues the
   * frame before. That splices the input, and a hit that sits in a splice is smeared or heard twice (two frames
   * carry it at slightly different times), and a hit a splice moved lands early or late. So around each attack
   * (`planTransient`) the frames just continue each other exactly (the input at its own speed, which overlap-adds back
   * to the original samples); the one frame that starts such a run is placed so the attack lands where the tempo puts
   * it, within a millisecond or two, and the stretch it skipped is made up by the frames after the run.
   */
  private computeFrame(): void {
    const rate = clamp(this.rateOut, 0.5, 2);
    const first = !this.hasPrev;
    const nominal = this.pos + rate * H - H;
    let s: number;
    let lo = 0;
    let hi = 2 * S;
    let kind = KIND_NORMAL;
    if (first) {
      s = Math.round(this.pos);
      this.offCarry = 0;
    } else {
      this.offCarry *= CARRY;
      s = Math.round(nominal + this.offCarry);
      if (this.transientsOn && this.stretchMode && (this.loopLen === 0 || this.loopLenI >= 4 * N)) {
        kind = this.planTransient(rate);
        if (kind !== KIND_NORMAL) {
          s = this.planStart;
          if (kind === KIND_ENTER) {
            lo = S - ENTRY_SEARCH;
            hi = S + ENTRY_SEARCH;
          }
        }
      }
    }
    const r0 = s - S;
    this.readRange(this.regL, this.regR, r0, R);
    let k = S;
    if (!first && kind !== KIND_CONTINUE) k = this.search(lo, hi);
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
    // A frame that is exact (the first, or part of a run around an attack) lets the next one continue it.
    this.cleanRun = first || kind !== KIND_NORMAL;
    if (kind !== KIND_NORMAL) this.offCarry = r0 + k - nominal;
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
  private search(lo: number, hi: number): number {
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
    // Coarse: candidates every 4 frames across the range (the whole ±S, or less for a frame that must land on time).
    const j0 = Math.ceil(lo / DEC);
    const j1 = Math.floor(hi / DEC);
    let e = 1e-9;
    for (let i = 0; i < TD; i++) e += (md[j0 + i] as number) * (md[j0 + i] as number);
    let bestJ = Math.round(S / DEC);
    let bestScore = -Infinity;
    const mid = S / DEC;
    for (let j = j0; j <= j1; j++) {
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
    const kLo = Math.max(lo, bestJ * DEC - DEC);
    const kHi = Math.min(hi, bestJ * DEC + DEC);
    for (let k = kLo; k <= kHi; k++) {
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
    if (snap.stalled && this.playing) {
      // The master waits for audio: it will come back somewhere else on its beat; land on it then.
      this.syncLocked = false;
      this.syncError = 0;
      this.alignPending = true;
      this.alignWait = Math.round(2 * this.sampleRate);
      return;
    }
    if (!snap.playing || snap.tempoRate <= 0) {
      this.syncLocked = false;
      this.syncError = 0;
      // A follower started together with its master waits a moment for it to start.
      if (this.alignPending && (this.alignWait -= n) <= 0) this.alignPending = false;
      return;
    }
    const sp = sy.spec;
    const sMap = sy.selfMap;
    const mMap = sy.masterMap;
    // The master's position at the first frame of this quantum.
    const mp = snap.pos + (frame - snap.frame) * snap.rate;
    // Tracked beats on either side: the tempo ratio is the one of the beats here and there (it moves as the songs drift),
    // and the phase counts the beats of each. Fixed grids on both sides keep the one ratio.
    const mult = sp.selfMult ?? 1;
    const selfLen = sMap ? sMap.lenAt(this.pos) / mult : sp.selfBeat;
    this.tempoEff = sMap || mMap ? (selfLen / (mMap ? mMap.lenAt(mp) : sp.masterBeat)) * snap.tempoRate : sp.ratio * snap.tempoRate;
    this.syncLocked = true;
    if (!this.playing || snap.scratching) {
      this.syncError = 0;
      return;
    }
    const phM = mMap ? mMap.beatAt(mp) : (mp - sp.masterFirst) / sp.masterBeat;
    const phS = sMap ? sMap.beatAt(this.pos) * mult : (this.pos - sp.selfFirst) / sp.selfBeat;
    let err = phS - phM;
    err -= Math.round(err);
    this.syncError = err;
    if (this.alignPending) {
      this.alignPending = false;
      // The master may be mid-jump (its position is a quantum old): align only when it is steady is not
      // knowable here, so just land on its beat now; the phase lock does the rest.
      if (!this.fresh) this.captureTail();
      this.pos = clamp(sMap ? sMap.posAt((phS - err) / mult) : this.pos - err * sp.selfBeat, 0, this.frames);
      this.resetStretch();
      if (this.isRunning) this.rise = this.declick;
      this.syncError = 0;
      return;
    }
    const secPerBeat = selfLen / (this.sampleRate * Math.max(0.1, this.rateOut));
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
    st[DS.rate] = running && !this.stalled ? this.rateOut : 0;
    st[DS.tempoRate] = this.playing ? this.tempoEff * (1 + this.nudgeCur) : 0;
    st[DS.playing] = running ? 1 : 0;
    st[DS.scratching] = this.scratching ? 1 : 0;
    st[DS.loopWraps] = this.loopWraps;
    st[DS.syncError] = this.syncError;
    st[DS.syncLocked] = this.syncLocked ? 1 : 0;
    st[DS.stalled] = this.stalled ? 1 : 0;
    Atomics.add(seq, 0, 1);
  }
}
