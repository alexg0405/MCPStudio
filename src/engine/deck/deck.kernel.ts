/**
 * The DJ deck's player, pure DSP (no DOM, no Web Audio): it plays a song held in memory from a fractional
 * position at a smoothed speed, so one object does everything a deck needs.
 *
 *  - Turntable playback: the position advances by the speed each output frame and the song is read with
 *    4-point cubic (Hermite) interpolation, so a faster deck is also higher, like a record. At exactly 1× it
 *    is a sample-exact copy.
 *  - Key lock: the same speed as a tempo only, by a streaming WSOLA (waveform-similarity overlap-add, see
 *    `deck-stretch.ts`): frames of 2048 samples, Hann-windowed, overlapped by half, each taken near where the tempo says
 *    it should come from and moved (±448 samples) to where it best continues the frame before, so the pitch holds. The
 *    nominal position keeps counting at the tempo, which is what sync and the loop read.
 *  - Loops: when the position crosses the loop end it moves back by the loop length (a fraction of a sample
 *    kept), and reads past the end continue from the loop start, so the seam is sample-accurate and seamless.
 *  - Jumps, starts and stops fade over 2 ms (the old sound's tail is rendered forward and faded out, the
 *    new one fades in), so a cue or a pause never clicks.
 *  - Scratch: the speed follows what the platter does (any speed, backwards too); nudge bends the tempo for a
 *    moment; the speed always glides.
 *  - Sync: a follower reads its master's published position and speed (shared memory) and holds the same tempo
 *    and beat phase by itself, every render quantum (`deck-sync.ts`), so it never drifts and needs no messages.
 *
 * No allocation in `process()`. The worklet (`deck.worklet.ts`) is the thin shell around it. What a deck publishes
 * is `deck-snapshot.ts`.
 *
 * Speed: the per-sample loop in `process()` and the interpolator are written so the engine inlines them. Anything
 * called per output sample stays in this file as a small method or inline code; helpers that run per block, per
 * stretch frame or per command are free to be separate methods or objects.
 */
import { BLOCK_BITS as BLOCK_BITS_OF_ID, BLOCK_FRAMES as BLOCK_FRAMES_OF_ID, BLOCK_MASK as BLOCK_MASK_OF_ID, DS } from './deck-id';
import type { SyncSpec } from './deck-id';
import { STRETCH_HOP_LEN, STRETCH_REGION_LEN, Stretcher } from './deck-stretch';
import { SyncFollower } from './deck-sync';

// Constants of this file: an imported binding is read through the module object (in tests, in some bundles), which made
// the per-sample reads below 5× slower.
const BLOCK_BITS = BLOCK_BITS_OF_ID;
const BLOCK_FRAMES = BLOCK_FRAMES_OF_ID;
const BLOCK_MASK = BLOCK_MASK_OF_ID;
const HOP_LEN = STRETCH_HOP_LEN;
const REGION_LEN = STRETCH_REGION_LEN;

// ---- Tempo, nudge, scratch ----

const MIN_TEMPO = 0.25;
const MAX_TEMPO = 4;
/** A nudge bends the tempo by at most this fraction, and ends this long after the last one. */
const MAX_NUDGE_BEND = 0.5;
const NUDGE_HOLD_SEC = 0.12;
/** The platter's speed is limited to this many times normal, either way. */
const MAX_SCRATCH_RATE = 24;
/** After a scratch lets go of a playing deck the speed glides back slowly for this long (seconds). */
const SPIN_UP_SEC = 0.25;

// ---- Fades and smoothing ----

/** Jumps, starts and stops fade over this long (seconds), never fewer than `MIN_DECLICK_FRAMES` frames. */
const DECLICK_SEC = 0.002;
const MIN_DECLICK_FRAMES = 8;
/** Time constants (seconds) of the speed's glide: normal, a scratch, the slow spin-up, and the nudge. */
const GLIDE_NORMAL_SEC = 0.006;
const GLIDE_SCRATCH_SEC = 0.003;
const GLIDE_SPIN_UP_SEC = 0.03;
const GLIDE_NUDGE_SEC = 0.008;

// ---- Streaming window ----

/** How far ahead (seconds) of the play position the audio must be there; twice that to leave a stall. */
const WINDOW_GUARD_SEC = 0.3;
/** The window check reads this far behind the position: the interpolator's reach, or the stretch's search. */
const WINDOW_BEHIND_INTERP = 16;
const WINDOW_BEHIND_STRETCH = 4096;
/** ... and ahead of it, beyond the guard: the interpolator's reach, or a stretch region plus slack. */
const WINDOW_AHEAD_INTERP = 16;
const WINDOW_AHEAD_STRETCH = REGION_LEN + 4096;
/** The speed the window check plans for is at most this (the stretch's range is lower), and never less than the speed plus this. */
const WINDOW_MAX_RATE = 4;
const WINDOW_RATE_SLACK = 0.05;

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export class DeckKernel {
  /** The song's blocks: planar float32 in a pool (`BLOCK_FRAMES` per slot), found through `table` (see `BLOCK_BITS`). */
  private poolLeft: Float32Array | null = null;
  private poolRight: Float32Array | null = null;
  private table: Int32Array = new Int32Array(0);
  private frames = 0;
  /** Where reads of the song stop being the plain blocks: the loop's end while one is on, else the song's. */
  private readLimit = 0;
  /** The pool holds a window of the song (some blocks may be missing): the player checks what it is about to read. */
  private isWindowed = false;
  /** Waiting for audio that isn't in the window yet: silent and not advancing until it is. */
  private stalled = false;
  /** How far ahead (frames) of the play position the audio must be there; twice that to leave a stall. */
  private readonly guardFrames: number;

  /** Where the deck is (frames, nominal: the stretch's frames sit within ±448 of it). */
  pos = 0;
  playing = false;
  private tempo = 1;
  private keyLock = false;
  private nudgeTarget = 0;
  private nudgeCurrent = 0;
  private nudgeAgeFrames = 0;
  private scratching = false;
  private scratchTarget = 0;
  /** The speed in use (smoothed): song frames per output frame. */
  private currentRate = 1;
  private spinUpFramesLeft = 0;

  /** The loop: its start and length as fractions of a frame, and rounded to whole frames for reading the song. */
  private loopStart = 0;
  private loopLength = 0;
  private loopStartFrame = 0;
  private loopLengthFrames = 1;
  private loopEndFrame = 0;
  loopWraps = 0;

  /** Following another deck: the tempo to run at, the phase lock, when to jump onto the master's beat. */
  private readonly follower: SyncFollower;
  /** Set when the deck starts from nothing, until its first frame is out. */
  private startingFromSilence = false;

  private shared: Float64Array | null = null;
  private seq: Int32Array | null = null;
  onEnded: (() => void) | null = null;

  // Fades.
  private readonly declickFrames: number;
  private readonly tailLeft: Float32Array;
  private readonly tailRight: Float32Array;
  private readonly olderTailLeft: Float32Array;
  private readonly olderTailRight: Float32Array;
  private tailLength = 0;
  private tailReadIndex = 0;
  /** Frames of fade-in still to go after a jump or start. */
  private fadeInFramesLeft = 0;
  private stretchMode = false;

  // Rates of the smoothing (the fraction of the way to the target covered per frame).
  private readonly glideNormal: number;
  private readonly glideScratch: number;
  private readonly glideSpinUp: number;
  private readonly glideNudge: number;

  /** The key-lock stretch. */
  private readonly stretcher: Stretcher;
  /** The sample the stretch (or the interpolator) produced last. */
  private sampleLeft = 0;
  private sampleRight = 0;

  constructor(readonly sampleRate: number) {
    this.declickFrames = Math.max(MIN_DECLICK_FRAMES, Math.round(DECLICK_SEC * sampleRate));
    this.tailLeft = new Float32Array(this.declickFrames);
    this.tailRight = new Float32Array(this.declickFrames);
    this.olderTailLeft = new Float32Array(this.declickFrames);
    this.olderTailRight = new Float32Array(this.declickFrames);
    this.guardFrames = Math.round(WINDOW_GUARD_SEC * sampleRate);
    this.stretcher = new Stretcher(sampleRate, (left, right, start, len) => this.readRange(left, right, start, len));
    this.follower = new SyncFollower(sampleRate);
    const glideOf = (sec: number) => 1 - Math.exp(-1 / (sec * sampleRate));
    this.glideNormal = glideOf(GLIDE_NORMAL_SEC);
    this.glideScratch = glideOf(GLIDE_SCRATCH_SEC);
    this.glideSpinUp = glideOf(GLIDE_SPIN_UP_SEC);
    this.glideNudge = glideOf(GLIDE_NUDGE_SEC);
  }

  /** Off turns the attack handling of the key-lock stretch off (a test compares with plain WSOLA). */
  get transientsOn(): boolean {
    return this.stretcher.transientsOn;
  }

  set transientsOn(on: boolean) {
    this.stretcher.transientsOn = on;
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
    const left = channels[0] as Float32Array;
    const songFrames = Math.min(frames, left.length);
    // Every block is where it would be in one array: the identity table.
    const table = new Int32Array(Math.ceil(songFrames / BLOCK_FRAMES));
    for (let block = 0; block < table.length; block++) table[block] = block;
    this.install(left, (channels[1] ?? left) as Float32Array, table, songFrames, false);
  }

  /**
   * A song as a window of its blocks: `poolL`/`poolR` hold `slots × BLOCK_FRAMES` frames, `table[b]` is the slot of block
   * `b` or −1. The main thread fills the pool and the table ahead of the play position (`deck-stream.ts`); a jump
   * outside the window waits (silent, a 2 ms fade out and in) until its blocks have come.
   */
  setStream(poolL: Float32Array, poolR: Float32Array, table: Int32Array, frames: number): void {
    this.install(poolL, poolR, table, frames, true);
  }

  private install(left: Float32Array | null, right: Float32Array | null, table: Int32Array, frames: number, isWindowed: boolean): void {
    this.captureTail();
    this.poolLeft = left;
    this.poolRight = right;
    this.table = table;
    this.frames = left ? frames : 0;
    this.readLimit = this.frames;
    this.isWindowed = isWindowed;
    this.stalled = false;
    this.playing = false;
    this.scratching = false;
    this.pos = 0;
    this.loopLength = 0;
    this.stretcher.reset();
    this.stretcher.clearOnsetCache();
    this.tailLength = 0;
  }

  /** Whether the player is waiting for audio to arrive (see `setStream`). */
  get isStalled(): boolean {
    return this.stalled;
  }

  get hasSong(): boolean {
    return this.poolLeft !== null;
  }

  get songFrames(): number {
    return this.frames;
  }

  get isRunning(): boolean {
    return this.playing || this.scratching;
  }

  // ---- Commands ----

  play(on: boolean): void {
    if (!this.poolLeft || on === this.playing) return;
    if (!on) {
      if (!this.scratching) this.captureTail();
      this.playing = false;
      return;
    }
    if (this.pos >= this.frames) this.pos = 0;
    this.playing = true;
    if (!this.scratching) {
      const isFollowing = this.follower.isFollowing && this.follower.isLocked;
      this.currentRate = (isFollowing ? this.follower.effectiveTempo : this.tempo) * (1 + this.nudgeCurrent);
      this.startFresh();
    }
    // A follower starts on the master's beat.
    if (this.follower.isFollowing) this.follower.requestAlign();
  }

  /** Jumps to `pos` (frames), fading over a couple of milliseconds when the deck is sounding. */
  seek(pos: number): void {
    if (!this.poolLeft) return;
    if (this.isRunning) this.captureTail();
    this.pos = clamp(pos, 0, this.frames);
    this.stretcher.reset();
    if (this.isRunning) this.fadeInFramesLeft = this.declickFrames;
  }

  setTempo(rate: number, keyLock: boolean): void {
    this.tempo = clamp(Number.isFinite(rate) ? rate : 1, MIN_TEMPO, MAX_TEMPO);
    this.keyLock = keyLock;
  }

  nudge(bend: number): void {
    this.nudgeTarget = clamp(bend, -MAX_NUDGE_BEND, MAX_NUDGE_BEND);
    this.nudgeAgeFrames = 0;
  }

  setScratching(on: boolean): void {
    if (on === this.scratching) return;
    if (on) {
      this.scratching = true;
      // Held where it is: a paused deck starts at rest, a playing one slows from the speed it had.
      if (!this.playing) this.currentRate = 0;
      this.scratchTarget = 0;
      if (this.poolLeft) this.fadeInFramesLeft = this.declickFrames;
      if (!this.playing) this.stretcher.reset();
      return;
    }
    this.scratching = false;
    if (this.playing) {
      this.spinUpFramesLeft = Math.round(SPIN_UP_SEC * this.sampleRate);
    } else {
      this.captureTail();
      this.currentRate = 0;
    }
  }

  setScratchRate(rate: number): void {
    this.scratchTarget = clamp(Number.isFinite(rate) ? rate : 0, -MAX_SCRATCH_RATE, MAX_SCRATCH_RATE);
  }

  /** A loop of `length` frames from `start` (positions that are on or past the end wrap into it). */
  setLoop(start: number, length: number): void {
    if (!(length > 0) || !this.poolLeft) {
      this.loopLength = 0;
      this.readLimit = this.frames;
      this.stretcher.clearOnsetCache();
      return;
    }
    this.stretcher.clearOnsetCache();
    this.loopStart = clamp(start, 0, this.frames);
    this.loopLength = Math.min(length, this.frames - this.loopStart);
    this.loopStartFrame = Math.round(this.loopStart);
    this.loopLengthFrames = Math.max(1, Math.round(this.loopLength));
    this.loopEndFrame = this.loopStartFrame + this.loopLengthFrames;
    this.readLimit = this.loopEndFrame;
    if (this.pos >= this.loopStart + this.loopLength) {
      if (this.isRunning) this.captureTail();
      this.pos = this.loopStart + ((this.pos - this.loopStart) % this.loopLength);
      this.stretcher.reset();
      if (this.isRunning) this.fadeInFramesLeft = this.declickFrames;
    }
  }

  clearLoop(): void {
    this.loopLength = 0;
    this.readLimit = this.frames;
    this.stretcher.clearOnsetCache();
  }

  get looping(): boolean {
    return this.loopLength > 0;
  }

  /** Moves a following deck to the master's beat at the next render quantum (it does so by itself when it starts). */
  align(): void {
    if (this.follower.isFollowing) this.follower.requestAlign();
  }

  setSync(spec: SyncSpec | null): void {
    this.follower.set(spec);
  }

  // ---- Rendering ----

  /** Renders `n` frames into outL/outR. `frame` is the context frame of the first one. */
  process(outL: Float32Array, outR: Float32Array, n: number, frame: number): void {
    this.followMaster(frame, n);
    this.publish(frame);
    if (!this.poolLeft) {
      for (let i = 0; i < n; i++) {
        outL[i] = 0;
        outR[i] = 0;
      }
      return;
    }
    this.prepareBlock(n);
    this.renderFrames(outL, outR, n);
  }

  /** The once-per-block work before rendering: the stretch mode follows key lock and scratch, a nudge ages out, the window is checked. */
  private prepareBlock(n: number): void {
    const wantStretch = this.keyLock && !this.scratching;
    if (wantStretch !== this.stretchMode) {
      if (this.isRunning) {
        this.captureTail();
        this.fadeInFramesLeft = this.declickFrames;
      }
      this.stretchMode = wantStretch;
      this.stretcher.reset();
    }
    this.nudgeAgeFrames += n;
    if (this.nudgeAgeFrames > NUDGE_HOLD_SEC * this.sampleRate) this.nudgeTarget = 0;
    if (this.isWindowed) this.checkWindow(n);
  }

  /**
   * The per-sample loop: the old sound's tail, the glide of the speed, the song (stretched or interpolated), the fade-in,
   * then the position's advance with its loop and end-of-song handling. It is kept in one body on purpose: it runs for
   * every output sample of every playing deck.
   */
  private renderFrames(outL: Float32Array, outR: Float32Array, n: number): void {
    const declickFrames = this.declickFrames;
    const stretcher = this.stretcher;
    const fifoLeft = stretcher.fifoLeft;
    const fifoRight = stretcher.fifoRight;
    // The tempo the deck runs at is worked out once per block (`followMaster`), before the samples.
    const effectiveTempo = this.follower.effectiveTempo;
    let isSounding = this.isRunning && !this.stalled;
    for (let i = 0; i < n; i++) {
      let left = 0;
      let right = 0;
      if (this.tailReadIndex < this.tailLength) {
        left = this.tailLeft[this.tailReadIndex] as number;
        right = this.tailRight[this.tailReadIndex] as number;
        this.tailReadIndex++;
      }
      this.nudgeCurrent += (this.nudgeTarget - this.nudgeCurrent) * this.glideNudge;
      if (isSounding) {
        // The speed glides toward what the platter or the tempo asks for.
        let targetRate: number;
        let glide: number;
        if (this.scratching) {
          targetRate = this.scratchTarget;
          glide = this.glideScratch;
        } else {
          targetRate = effectiveTempo * (1 + this.nudgeCurrent);
          if (this.spinUpFramesLeft > 0) {
            glide = this.glideSpinUp;
            this.spinUpFramesLeft--;
          } else glide = this.glideNormal;
        }
        this.currentRate += (targetRate - this.currentRate) * glide;
        const rate = this.currentRate;

        if (this.stretchMode) {
          if (stretcher.fifoReadIndex >= HOP_LEN) {
            stretcher.computeFrame(this.pos, this.currentRate, this.loopLength > 0 ? this.loopLengthFrames : 0, this.loopEndFrame);
          }
          this.sampleLeft = fifoLeft[stretcher.fifoReadIndex] as number;
          this.sampleRight = fifoRight[stretcher.fifoReadIndex] as number;
          stretcher.fifoReadIndex++;
        } else {
          this.sampleLeft = this.interp(this.poolLeft as Float32Array, this.pos);
          this.sampleRight = this.poolRight === this.poolLeft ? this.sampleLeft : this.interp(this.poolRight as Float32Array, this.pos);
        }
        if (this.fadeInFramesLeft > 0) {
          const gain = 1 - this.fadeInFramesLeft / declickFrames;
          this.fadeInFramesLeft--;
          left += this.sampleLeft * gain;
          right += this.sampleRight * gain;
        } else {
          left += this.sampleLeft;
          right += this.sampleRight;
        }

        this.startingFromSilence = false;
        this.pos += rate;
        if (this.loopLength > 0) {
          const loopEnd = this.loopStart + this.loopLength;
          if (rate > 0 && this.pos >= loopEnd) {
            this.pos -= this.loopLength;
            if (this.pos >= loopEnd) this.pos = this.loopStart + ((this.pos - this.loopStart) % this.loopLength);
            this.loopWraps++;
          } else if (rate < 0 && this.pos < this.loopStart) {
            this.pos += this.loopLength;
          }
        }
        if (this.pos >= this.frames) {
          // The end of the song: the last bit rings out through the tail, then it stops.
          this.pos = this.frames;
          this.captureTail();
          this.playing = false;
          this.scratching = false;
          isSounding = false;
          this.onEnded?.();
        } else if (this.pos < 0) {
          this.pos = 0;
          if (this.scratching) this.currentRate = 0;
        }
      }
      outL[i] = left;
      outR[i] = right;
    }
  }

  // ---- Sync ----

  /** Follows the master's tempo and beat phase for this render quantum; jumps onto its beat when it is time. */
  private followMaster(frame: number, n: number): void {
    const landing = this.follower.update(frame, n, this.tempo, this.playing, this.pos, this.currentRate);
    if (landing === null) return;
    if (!this.startingFromSilence) this.captureTail();
    this.pos = clamp(landing, 0, this.frames);
    this.stretcher.reset();
    if (this.isRunning) this.fadeInFramesLeft = this.declickFrames;
  }

  // ---- The streaming window ----

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
    const planRate = Math.min(WINDOW_MAX_RATE, Math.abs(this.currentRate) + WINDOW_RATE_SLACK);
    const from = this.pos - (this.stretchMode ? WINDOW_BEHIND_STRETCH : WINDOW_BEHIND_INTERP + planRate * n);
    const guard = this.guardFrames * (this.stalled ? 2 : 1);
    const to = this.pos + planRate * (n + guard) + (this.stretchMode ? WINDOW_AHEAD_STRETCH : WINDOW_AHEAD_INTERP);
    const isReady = this.isResident(from, to);
    if (!this.stalled && !isReady) {
      // What sounds now fades out over the next 2 ms (it is in the window: the check above looks ahead far enough).
      this.captureTail();
      this.stalled = true;
    } else if (this.stalled && isReady) {
      this.stalled = false;
      this.stretcher.reset();
      this.fadeInFramesLeft = this.declickFrames;
    }
  }

  /** Whether every block under frames [from, to) is in the window (loop seams followed). */
  private isResident(from: number, to: number): boolean {
    const first = Math.max(0, Math.floor(from));
    const end = Math.min(this.frames, Math.ceil(to));
    if (end <= first) return true;
    if (this.loopLength > 0 && end > this.loopEndFrame) {
      // Past the loop end the sound comes from its start.
      if (first < this.loopEndFrame && !this.blocksResident(first, this.loopEndFrame)) return false;
      const wrappedLength = end - Math.max(first, this.loopEndFrame);
      return this.blocksResident(this.loopStartFrame, Math.min(this.loopEndFrame, this.loopStartFrame + wrappedLength));
    }
    return this.blocksResident(first, end);
  }

  private blocksResident(first: number, end: number): boolean {
    const lastBlock = (end - 1) >>> BLOCK_BITS;
    for (let block = first >>> BLOCK_BITS; block <= lastBlock; block++) if (Atomics.load(this.table, block) < 0) return false;
    return true;
  }

  // ---- Starting, stopping and the fade tail ----

  /** Starts sounding at the current position from nothing (play, a seek while stopped). */
  private startFresh(): void {
    this.startingFromSilence = true;
    this.stretcher.reset();
    this.fadeInFramesLeft = this.declickFrames;
    this.stretchMode = this.keyLock && !this.scratching;
  }

  /** Renders the next 2 ms of what is sounding, faded out, so a jump or a stop can play it under the new sound. */
  private captureTail(): void {
    if (!this.poolLeft || !this.isRunning) {
      this.tailLength = 0;
      this.tailReadIndex = 0;
      return;
    }
    const keptFrames = this.setAsideOlderTail();
    if (this.stretchMode) this.stretcher.copyTail(this.tailLeft, this.tailRight, this.declickFrames);
    else this.renderTailFromSong();
    this.fadeTailOut(keptFrames);
    this.tailLength = this.declickFrames;
    this.tailReadIndex = 0;
  }

  /** What the new sound doesn't replace yet keeps playing: whatever is left of an older tail is set aside first. Returns how much. */
  private setAsideOlderTail(): number {
    const left = this.tailLength - this.tailReadIndex;
    for (let k = 0; k < left; k++) {
      this.olderTailLeft[k] = this.tailLeft[this.tailReadIndex + k] as number;
      this.olderTailRight[k] = this.tailRight[this.tailReadIndex + k] as number;
    }
    return left;
  }

  /** The tail of a turntable-style deck: the song read on at the speed it has, following a loop, stopping at the song's ends. */
  private renderTailFromSong(): void {
    const poolLeft = this.poolLeft as Float32Array;
    const poolRight = this.poolRight as Float32Array;
    let p = this.pos;
    let rate = this.currentRate;
    for (let k = 0; k < this.declickFrames; k++) {
      this.tailLeft[k] = this.interp(poolLeft, p);
      this.tailRight[k] = poolRight === poolLeft ? (this.tailLeft[k] as number) : this.interp(poolRight, p);
      p += rate;
      if (this.loopLength > 0 && rate > 0 && p >= this.loopStart + this.loopLength) p -= this.loopLength;
      if (p < 0 || p >= this.frames) rate = 0;
    }
  }

  /** Fades the rendered tail to zero and adds the older tail that was set aside under it. */
  private fadeTailOut(keptFrames: number): void {
    const length = this.declickFrames;
    for (let k = 0; k < length; k++) {
      const gain = 1 - (k + 1) / length;
      const keptLeft = k < keptFrames ? (this.olderTailLeft[k] as number) : 0;
      const keptRight = k < keptFrames ? (this.olderTailRight[k] as number) : 0;
      this.tailLeft[k] = (this.tailLeft[k] as number) * gain + keptLeft;
      this.tailRight[k] = (this.tailRight[k] as number) * gain + keptRight;
    }
  }

  // ---- Reading the song ----

  /** One sample of a channel at a whole frame: loop seams followed, zero outside the song and where the window has no block. */
  private at(channel: Float32Array, frame: number): number {
    let i = frame;
    if (this.loopLength > 0 && i >= this.loopEndFrame) i = this.loopStartFrame + ((i - this.loopStartFrame) % this.loopLengthFrames);
    if (i < 0 || i >= this.frames) return 0;
    const slot = this.table[i >>> BLOCK_BITS] as number;
    return slot < 0 ? 0 : (channel[(slot << BLOCK_BITS) | (i & BLOCK_MASK)] as number);
  }

  /**
   * The song at a fractional position, cubic (Hermite) between the four nearest frames. The usual case, four frames in one
   * block that is there, is read straight (and small enough to be inlined into the render loop); the rest (a block
   * edge, a loop seam, the song's ends, a missing block) goes through `at`.
   */
  private interp(channel: Float32Array, position: number): number {
    const i = Math.floor(position);
    const f = position - i;
    const block = (i - 1) >>> BLOCK_BITS;
    if (f !== 0 && i >= 1 && i + 2 < this.readLimit && block === (i + 2) >>> BLOCK_BITS) {
      const slot = this.table[block] as number;
      if (slot >= 0) {
        const o = (slot << BLOCK_BITS) | ((i - 1) & BLOCK_MASK);
        const y0 = channel[o] as number;
        const y1 = channel[o + 1] as number;
        const y2 = channel[o + 2] as number;
        const y3 = channel[o + 3] as number;
        return (((0.5 * (y3 - y0) + 1.5 * (y1 - y2)) * f + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * f + 0.5 * (y2 - y0)) * f + y1;
      }
    }
    return this.interpSlow(channel, i, f);
  }

  /** The cubic through `at` (the same Hermite curve as `interp`), for the places the fast path can't read straight. */
  private interpSlow(channel: Float32Array, i: number, f: number): number {
    if (f === 0) return this.at(channel, i);
    const y0 = this.at(channel, i - 1);
    const y1 = this.at(channel, i);
    const y2 = this.at(channel, i + 1);
    const y3 = this.at(channel, i + 2);
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }

  /** Copies `len` frames from `start` into dst (zeros outside the song and where the window has none; reads past a loop end continue from its start). */
  private readRange(dstLeft: Float32Array, dstRight: Float32Array, start: number, len: number): void {
    const poolLeft = this.poolLeft as Float32Array;
    const poolRight = this.poolRight as Float32Array;
    const isLooping = this.loopLength > 0;
    let written = 0;
    let frame = start;
    while (written < len) {
      let source = frame;
      if (isLooping && source >= this.loopEndFrame) source = this.loopStartFrame + ((source - this.loopStartFrame) % this.loopLengthFrames);
      if (source < 0) {
        // Before the song: silence until it begins.
        const run = Math.min(len - written, -source);
        zeroFill(dstLeft, dstRight, written, run);
        written += run;
        frame += run;
      } else if (source >= this.frames) {
        zeroFill(dstLeft, dstRight, written, len - written);
        return;
      } else {
        const limit = isLooping && source < this.loopEndFrame ? this.loopEndFrame : this.frames;
        // The part of the run that is in this block.
        const run = Math.min(len - written, limit - source, BLOCK_FRAMES - (source & BLOCK_MASK));
        const slot = this.table[source >>> BLOCK_BITS] as number;
        if (slot < 0) {
          zeroFill(dstLeft, dstRight, written, run);
        } else {
          const base = (slot << BLOCK_BITS) | (source & BLOCK_MASK);
          for (let k = 0; k < run; k++) {
            dstLeft[written + k] = poolLeft[base + k] as number;
            dstRight[written + k] = poolRight[base + k] as number;
          }
        }
        written += run;
        frame += run;
      }
    }
  }

  // ---- Publishing ----

  /** Writes the deck's state where the main thread and followers read it (under the sequence lock, see `deck-snapshot.ts`). */
  private publish(frame: number): void {
    const state = this.shared;
    const seq = this.seq;
    if (!state || !seq) return;
    Atomics.add(seq, 0, 1);
    state[DS.pos] = this.pos;
    state[DS.frame] = frame;
    const isRunning = this.isRunning;
    state[DS.rate] = isRunning && !this.stalled ? this.currentRate : 0;
    state[DS.tempoRate] = this.playing ? this.follower.effectiveTempo * (1 + this.nudgeCurrent) : 0;
    state[DS.playing] = isRunning ? 1 : 0;
    state[DS.scratching] = this.scratching ? 1 : 0;
    state[DS.loopWraps] = this.loopWraps;
    state[DS.syncError] = this.follower.phaseError;
    state[DS.syncLocked] = this.follower.isLocked ? 1 : 0;
    state[DS.stalled] = this.stalled ? 1 : 0;
    Atomics.add(seq, 0, 1);
  }
}

/** Sets `count` frames of both arrays to zero from `from`. */
function zeroFill(left: Float32Array, right: Float32Array, from: number, count: number): void {
  for (let k = 0; k < count; k++) {
    left[from + k] = 0;
    right[from + k] = 0;
  }
}
