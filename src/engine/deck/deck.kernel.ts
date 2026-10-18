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
 * No allocation in `process()`. The worklet (`deck.worklet.ts`) is the thin shell around it. The attack detector the
 * stretch uses is `onset-scanner.ts`; what a deck publishes is `deck-snapshot.ts`.
 *
 * Speed: the per-sample loop in `process()` and the interpolator are written so the engine inlines them. Anything
 * called per output sample stays in this file as a small method or inline code; helpers that run per block, per
 * stretch frame or per command are free to be separate methods.
 */
import { BeatMap } from '@core/dj/beat-map';
import { BLOCK_BITS as BLOCK_BITS_OF_ID, BLOCK_FRAMES as BLOCK_FRAMES_OF_ID, BLOCK_MASK as BLOCK_MASK_OF_ID, DS } from './deck-id';
import type { SyncSpec } from './deck-id';
import { newSnapshot, readDeckState } from './deck-snapshot';
import { OnsetScanner } from './onset-scanner';

// Constants of this file: an imported binding is read through the module object (in tests, in some bundles), which made
// the per-sample reads below 5× slower.
const BLOCK_BITS = BLOCK_BITS_OF_ID;
const BLOCK_FRAMES = BLOCK_FRAMES_OF_ID;
const BLOCK_MASK = BLOCK_MASK_OF_ID;

// ---- Stretch (key lock) geometry ----

/** Length of a stretch frame (samples), and the hop between frames (half a frame: they overlap by half). */
const FRAME_LEN = 2048;
const HOP_LEN = FRAME_LEN / 2;
/** How far (samples) a frame may move from where the tempo says it comes from, to better continue the frame before. */
const SEARCH_RADIUS = 448;
/** The coarse similarity search looks at every this-many-th sample of a mono mix. */
const SEARCH_DECIMATION = 4;
/** The region of the song a frame's search reads (the frame plus the search radius either side). */
const REGION_LEN = 2 * SEARCH_RADIUS + FRAME_LEN;
/** The same region, and the half-frame template it is matched against, after decimation. */
const REGION_LEN_DECIMATED = REGION_LEN / SEARCH_DECIMATION;
const TEMPLATE_LEN_DECIMATED = HOP_LEN / SEARCH_DECIMATION;
/** How far from the nominal place a frame's best match may sit before it costs (correlation points per full range). */
const CENTER_BIAS = 0.03;

const HANN_WINDOW = new Float32Array(FRAME_LEN);
/** The window of the very first frame: full for its first half (nothing to overlap with), Hann after. */
const FIRST_FRAME_WINDOW = new Float32Array(FRAME_LEN);
for (let j = 0; j < FRAME_LEN; j++) {
  HANN_WINDOW[j] = 0.5 * (1 - Math.cos((2 * Math.PI * j) / FRAME_LEN));
  FIRST_FRAME_WINDOW[j] = j < HOP_LEN ? 1 : (HANN_WINDOW[j] as number);
}

// ---- Transient preservation: what `computeFrame` does with a frame (see `planTransient`) ----

const FRAME_NORMAL = 0;
const FRAME_CONTINUE = 1;
const FRAME_ENTER = 2;
/** The fraction of the lead (how far the heard input is from where the tempo puts it) that still stands after one more frame. */
const LEAD_CARRY = 0.5;
/** The frame that starts a run around an attack may move this far (frames) to continue the one before: 1.3 ms at 48 kHz. */
const ENTRY_SEARCH = 64;
/** A run starts this many output frames before its attack: past the splice that starts it (a hop) and the attack's own lead-in. */
const RUN_LEAD = HOP_LEN + 320;
/** A run goes on until the next splice would begin this far (frames) after the attack: past its body and the search's reach. */
const RUN_TAIL = 930;
/** How far (output frames) a continued run may put an attack from where the tempo wants it: 2 ms at 48 kHz. */
const LANDING_TOLERANCE = 96;
/** An attack this close (output frames) before a stronger one gives way to it (their runs could not both fit). */
const RUN_SPAN = RUN_LEAD + HOP_LEN + RUN_TAIL + HOP_LEN;
/** The most a run's first frame may jump from where the frame before leads on (frames). */
const MAX_ENTRY_JUMP = 1500;
/** Loops shorter than this many frames are too short for a run around an attack to fit, so they use plain WSOLA. */
const MIN_LOOP_FOR_TRANSIENTS = 4 * FRAME_LEN;
/** The stretch only follows tempos between half and double speed (outside it the search region would not cover the frame). */
const MIN_STRETCH_RATE = 0.5;
const MAX_STRETCH_RATE = 2;

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

// ---- Sync ----

/** The most a follower trims its tempo to close a beat-phase error (a fraction). */
const MAX_SYNC_TRIM = 0.02;
/** Seconds a follower takes to close a beat-phase error. */
const SYNC_TIME_CONSTANT_SEC = 1.5;
/** A pending align waits this long (seconds) for a master that isn't playing yet. */
const ALIGN_WAIT_SEC = 0.15;
/** ... or this long when the master is waiting for audio and will come back somewhere else. */
const ALIGN_WAIT_AFTER_STALL_SEC = 2;
/** The slowest speed the sync's beat-phase trim assumes (so a nearly stopped deck doesn't divide by nothing). */
const MIN_SYNC_RATE = 0.1;

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** The clock of a song's tracked beats, or null when there are too few to follow (or they don't make a clock). */
function beatMapOf(beats: Float64Array | undefined, firstDownbeat: number): BeatMap | null {
  if (!beats || beats.length < 2) return null;
  try {
    return new BeatMap(beats, firstDownbeat);
  } catch {
    return null;
  }
}

/** A follower deck's link to its master: the spec it was given and the shared state it reads. */
interface SyncState {
  spec: SyncSpec;
  state: Float64Array;
  seq: Int32Array;
  /** The beat clocks of the two songs when they have tracked beats (null: the fixed grid in `spec`). */
  selfMap: BeatMap | null;
  masterMap: BeatMap | null;
}

/** The deck player: one object that plays a song at a smoothed speed with key lock, loops, fades, scratch and sync (see the file comment). */
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
  /** The tempo the deck runs at: its own, or the master's matched (and trimmed to close the beat-phase error) when following. */
  private effectiveTempo = 1;

  /** The loop: its start and length as fractions of a frame, and rounded to whole frames for reading the song. */
  private loopStart = 0;
  private loopLength = 0;
  private loopStartFrame = 0;
  private loopLengthFrames = 1;
  private loopEndFrame = 0;
  loopWraps = 0;

  private sync: SyncState | null = null;
  private syncError = 0;
  private syncLocked = false;
  /** Jump to the master's beat at the next quantum (a start, a sync press, the master jumped). */
  private alignPending = false;
  /** Frames a pending align waits for a master that isn't playing yet (a follower started together with it). */
  private alignWaitFrames = 0;
  /** Set when the deck starts from nothing, until its first frame is out. */
  private startingFromSilence = false;
  private readonly masterSnapshot = newSnapshot();

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

  // Stretch state.
  /** The overlap-add accumulator: the frame being built (two hops long); its first hop is finished at each frame. */
  private readonly overlapLeft = new Float32Array(FRAME_LEN);
  private readonly overlapRight = new Float32Array(FRAME_LEN);
  /** The finished hop being played out, and where in it the output is. */
  private readonly fifoLeft = new Float32Array(HOP_LEN);
  private readonly fifoRight = new Float32Array(HOP_LEN);
  private fifoReadIndex = HOP_LEN;
  private hasPreviousFrame = false;
  /** The song frame the previous stretch frame was taken from. */
  private previousFrameStart = 0;
  /** The region of the song a frame's search reads, and its mono and decimated mono mixes. */
  private readonly regionLeft = new Float32Array(REGION_LEN);
  private readonly regionRight = new Float32Array(REGION_LEN);
  private readonly regionMono = new Float32Array(REGION_LEN);
  private readonly regionMonoDecimated = new Float32Array(REGION_LEN_DECIMATED);
  /** The part of the previous frame still to be heard (what the next frame must continue), as mono and decimated mono. */
  private readonly templateLeft = new Float32Array(HOP_LEN);
  private readonly templateRight = new Float32Array(HOP_LEN);
  private readonly templateMono = new Float32Array(HOP_LEN);
  private readonly templateMonoDecimated = new Float32Array(TEMPLATE_LEN_DECIMATED);
  /** The sample the stretch (or the interpolator) produced last. */
  private sampleLeft = 0;
  private sampleRight = 0;

  // Transient preservation (see `computeFrame`).
  /** Off turns the attack handling off (a test compares with plain WSOLA). */
  transientsOn = true;
  private readonly onsets: OnsetScanner;
  /** The frame before was exact (the first, or inside a run around an attack): the next may continue it. */
  private previousFrameWasExact = false;
  /** Where the heard input is relative to where the tempo puts it after a run; closes by `LEAD_CARRY` a frame. */
  private leadCarry = 0;
  /** Set by `planTransient`: the song frame a continued or entering frame starts from. */
  private plannedStart = 0;
  /** Set by `planFrame`: where the frame's search may look, as offsets in the region (0…2·SEARCH_RADIUS). */
  private searchLow = 0;
  private searchHigh = 0;

  constructor(readonly sampleRate: number) {
    this.declickFrames = Math.max(MIN_DECLICK_FRAMES, Math.round(DECLICK_SEC * sampleRate));
    this.tailLeft = new Float32Array(this.declickFrames);
    this.tailRight = new Float32Array(this.declickFrames);
    this.olderTailLeft = new Float32Array(this.declickFrames);
    this.olderTailRight = new Float32Array(this.declickFrames);
    this.guardFrames = Math.round(WINDOW_GUARD_SEC * sampleRate);
    this.onsets = new OnsetScanner(sampleRate, (left, right, start, len) => this.readRange(left, right, start, len));
    const glideOf = (sec: number) => 1 - Math.exp(-1 / (sec * sampleRate));
    this.glideNormal = glideOf(GLIDE_NORMAL_SEC);
    this.glideScratch = glideOf(GLIDE_SCRATCH_SEC);
    this.glideSpinUp = glideOf(GLIDE_SPIN_UP_SEC);
    this.glideNudge = glideOf(GLIDE_NUDGE_SEC);
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
    this.resetStretch();
    this.onsets.clearCache();
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
      const isFollowing = this.sync !== null && this.syncLocked;
      this.currentRate = (isFollowing ? this.effectiveTempo : this.tempo) * (1 + this.nudgeCurrent);
      this.startFresh();
    }
    // A follower starts on the master's beat.
    if (this.sync) this.requestAlign();
  }

  /** Jumps to `pos` (frames), fading over a couple of milliseconds when the deck is sounding. */
  seek(pos: number): void {
    if (!this.poolLeft) return;
    if (this.isRunning) this.captureTail();
    this.pos = clamp(pos, 0, this.frames);
    this.resetStretch();
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
      if (!this.playing) this.resetStretch();
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
      this.onsets.clearCache();
      return;
    }
    this.onsets.clearCache();
    this.loopStart = clamp(start, 0, this.frames);
    this.loopLength = Math.min(length, this.frames - this.loopStart);
    this.loopStartFrame = Math.round(this.loopStart);
    this.loopLengthFrames = Math.max(1, Math.round(this.loopLength));
    this.loopEndFrame = this.loopStartFrame + this.loopLengthFrames;
    this.readLimit = this.loopEndFrame;
    if (this.pos >= this.loopStart + this.loopLength) {
      if (this.isRunning) this.captureTail();
      this.pos = this.loopStart + ((this.pos - this.loopStart) % this.loopLength);
      this.resetStretch();
      if (this.isRunning) this.fadeInFramesLeft = this.declickFrames;
    }
  }

  clearLoop(): void {
    this.loopLength = 0;
    this.readLimit = this.frames;
    this.onsets.clearCache();
  }

  get looping(): boolean {
    return this.loopLength > 0;
  }

  /** Moves a following deck to the master's beat at the next render quantum (it does so by itself when it starts). */
  align(): void {
    if (this.sync) this.requestAlign();
  }

  private requestAlign(): void {
    this.alignPending = true;
    this.alignWaitFrames = Math.round(ALIGN_WAIT_SEC * this.sampleRate);
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
      this.resetStretch();
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
          targetRate = this.effectiveTempo * (1 + this.nudgeCurrent);
          if (this.spinUpFramesLeft > 0) {
            glide = this.glideSpinUp;
            this.spinUpFramesLeft--;
          } else glide = this.glideNormal;
        }
        this.currentRate += (targetRate - this.currentRate) * glide;
        const rate = this.currentRate;

        if (this.stretchMode) {
          if (this.fifoReadIndex >= HOP_LEN) this.computeFrame();
          this.sampleLeft = this.fifoLeft[this.fifoReadIndex] as number;
          this.sampleRight = this.fifoRight[this.fifoReadIndex] as number;
          this.fifoReadIndex++;
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
      this.resetStretch();
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
    this.resetStretch();
    this.fadeInFramesLeft = this.declickFrames;
    this.stretchMode = this.keyLock && !this.scratching;
  }

  private resetStretch(): void {
    this.fifoReadIndex = HOP_LEN;
    this.hasPreviousFrame = false;
    this.overlapLeft.fill(0);
    this.overlapRight.fill(0);
  }

  /** Renders the next 2 ms of what is sounding, faded out, so a jump or a stop can play it under the new sound. */
  private captureTail(): void {
    if (!this.poolLeft || !this.isRunning) {
      this.tailLength = 0;
      this.tailReadIndex = 0;
      return;
    }
    const keptFrames = this.setAsideOlderTail();
    if (this.stretchMode) this.renderTailFromStretch();
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

  /** The tail of a stretching deck: the finished samples first, then the half-frame still waiting to be overlapped. */
  private renderTailFromStretch(): void {
    const length = this.declickFrames;
    let k = 0;
    for (let f = this.fifoReadIndex; f < HOP_LEN && k < length; f++, k++) {
      this.tailLeft[k] = this.fifoLeft[f] as number;
      this.tailRight[k] = this.fifoRight[f] as number;
    }
    for (let j = 0; k < length; j++, k++) {
      this.tailLeft[k] = this.overlapLeft[j] as number;
      this.tailRight[k] = this.overlapRight[j] as number;
    }
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

  // ---- Key lock: planning around attacks ----

  /**
   * Whether the next frame should continue the one before exactly (`FRAME_CONTINUE`: inside a run around an attack),
   * start such a run (`FRAME_ENTER`, placed so the attack lands on time, in `plannedStart`) or be an ordinary WSOLA frame.
   *
   * Everything is in input frames of the nominal lap (a loop's seam is unwrapped around the playhead) and output frames.
   * `leadsOn` is where the previous frame leads on (what a frame that continues it starts at); a run keeps that, and the
   * attack at `c` is then heard `c − leadsOn` frames from now, against the `(c − pos)/rate` the tempo asks for.
   */
  private planTransient(rate: number): number {
    const pos = this.pos;
    let leadsOn = this.previousFrameStart + HOP_LEN;
    if (this.loopLength > 0) {
      const loopLen = this.loopLengthFrames;
      if (leadsOn - pos > loopLen / 2) leadsOn -= loopLen;
      else if (leadsOn - pos < -loopLen / 2) leadsOn += loopLen;
    }
    const hop = this.onsets.hop;
    this.onsets.scan(
      Math.min(leadsOn, pos) - RUN_TAIL - 2 * hop,
      Math.max(leadsOn, pos) + (RUN_LEAD + HOP_LEN + RUN_SPAN) * rate + 2 * hop,
    );
    if (this.previousFrameWasExact && this.canContinueRun(leadsOn, pos, rate)) {
      this.plannedStart = leadsOn;
      return FRAME_CONTINUE;
    }
    return this.findEntry(leadsOn, pos, rate) ? FRAME_ENTER : FRAME_NORMAL;
  }

  /** Whether the next attack within reach of the run is one the run, kept going, puts on time. */
  private canContinueRun(leadsOn: number, pos: number, rate: number): boolean {
    const count = this.onsets.count;
    const attackFrames = this.onsets.frames;
    for (let i = 0; i < count; i++) {
      const attack = attackFrames[i] as number;
      const heardIn = attack - leadsOn;
      if (heardIn <= -RUN_TAIL) continue;
      if (heardIn >= RUN_LEAD + HOP_LEN) return false;
      return Math.abs(heardIn - (attack - pos) / rate) <= LANDING_TOLERANCE;
    }
    return false;
  }

  /** Looks for an attack that is about to come due, and if one is, plans the frame that starts a run around it (`plannedStart`). */
  private findEntry(leadsOn: number, pos: number, rate: number): boolean {
    const count = this.onsets.count;
    const attackFrames = this.onsets.frames;
    const strengths = this.onsets.strengths;
    for (let i = 0; i < count; i++) {
      const attack = attackFrames[i] as number;
      const dueIn = (attack - pos) / rate;
      if (dueIn < RUN_LEAD) continue;
      if (dueIn >= RUN_LEAD + HOP_LEN) break;
      if (this.isOutdoneByNextAttack(i, rate, attackFrames, strengths)) continue;
      const start = Math.round(attack - dueIn);
      if (Math.abs(start - leadsOn) > MAX_ENTRY_JUMP) continue;
      this.plannedStart = start;
      return true;
    }
    return false;
  }

  /** Whether a stronger attack follows attack `i` closely enough that their runs could not both fit. */
  private isOutdoneByNextAttack(i: number, rate: number, attackFrames: Float64Array, strengths: Float64Array): boolean {
    const count = this.onsets.count;
    const attack = attackFrames[i] as number;
    for (let j = i + 1; j < count; j++) {
      if (((attackFrames[j] as number) - attack) / rate >= RUN_SPAN) return false;
      if ((strengths[j] as number) > (strengths[i] as number)) return true;
    }
    return false;
  }

  // ---- Key lock: one WSOLA frame ----

  /**
   * One WSOLA frame: picks where in the song it comes from, overlap-adds it and refills the output hop.
   *
   * A frame normally comes from where the tempo says its centre is and moves (±SEARCH_RADIUS) to where it best continues
   * the frame before. That splices the input, and a hit that sits in a splice is smeared or heard twice (two frames
   * carry it at slightly different times), and a hit a splice moved lands early or late. So around each attack
   * (`planTransient`) the frames just continue each other exactly (the input at its own speed, which overlap-adds back
   * to the original samples); the one frame that starts such a run is placed so the attack lands where the tempo puts
   * it, within a millisecond or two, and the stretch it skipped is made up by the frames after the run.
   */
  private computeFrame(): void {
    const rate = clamp(this.currentRate, MIN_STRETCH_RATE, MAX_STRETCH_RATE);
    const isFirst = !this.hasPreviousFrame;
    const nominalStart = this.pos + rate * HOP_LEN - HOP_LEN;
    const kind = this.planFrame(isFirst, rate, nominalStart);
    const regionStart = this.plannedStart - SEARCH_RADIUS;
    this.readRange(this.regionLeft, this.regionRight, regionStart, REGION_LEN);
    let offset = SEARCH_RADIUS;
    if (!isFirst && kind !== FRAME_CONTINUE) offset = this.search(this.searchLow, this.searchHigh);
    this.overlapAdd(offset, isFirst ? FIRST_FRAME_WINDOW : HANN_WINDOW);
    this.previousFrameStart = regionStart + offset;
    if (this.loopLength > 0 && this.previousFrameStart >= this.loopEndFrame) this.previousFrameStart -= this.loopLengthFrames;
    this.hasPreviousFrame = true;
    // A frame that is exact (the first, or part of a run around an attack) lets the next one continue it.
    this.previousFrameWasExact = isFirst || kind !== FRAME_NORMAL;
    if (kind !== FRAME_NORMAL) this.leadCarry = regionStart + offset - nominalStart;
    this.emitFinishedHop();
  }

  /**
   * Decides where the next frame is taken from (`plannedStart`, the song frame at the middle of the search region) and
   * how far its search may look (`searchLow`…`searchHigh`). Returns the kind of frame (see `planTransient`).
   */
  private planFrame(isFirst: boolean, rate: number, nominalStart: number): number {
    this.searchLow = 0;
    this.searchHigh = 2 * SEARCH_RADIUS;
    if (isFirst) {
      this.plannedStart = Math.round(this.pos);
      this.leadCarry = 0;
      return FRAME_NORMAL;
    }
    this.leadCarry *= LEAD_CARRY;
    this.plannedStart = Math.round(nominalStart + this.leadCarry);
    const canPreserveAttacks = this.transientsOn && this.stretchMode && (this.loopLength === 0 || this.loopLengthFrames >= MIN_LOOP_FOR_TRANSIENTS);
    if (!canPreserveAttacks) return FRAME_NORMAL;
    const kind = this.planTransient(rate);
    if (kind === FRAME_ENTER) {
      this.searchLow = SEARCH_RADIUS - ENTRY_SEARCH;
      this.searchHigh = SEARCH_RADIUS + ENTRY_SEARCH;
    }
    // `planTransient` set `plannedStart` for a continued or entering frame; a normal one keeps the tempo's place.
    return kind;
  }

  /** Adds the chosen part of the region, windowed, into the overlap accumulator. */
  private overlapAdd(offset: number, window: Float32Array): void {
    const overlapLeft = this.overlapLeft;
    const overlapRight = this.overlapRight;
    const regionLeft = this.regionLeft;
    const regionRight = this.regionRight;
    for (let j = 0; j < FRAME_LEN; j++) {
      const w = window[j] as number;
      overlapLeft[j] = (overlapLeft[j] as number) + w * (regionLeft[offset + j] as number);
      overlapRight[j] = (overlapRight[j] as number) + w * (regionRight[offset + j] as number);
    }
  }

  /** The first hop of the accumulator is finished: it becomes the output, and the second hop moves up to be overlapped next. */
  private emitFinishedHop(): void {
    const overlapLeft = this.overlapLeft;
    const overlapRight = this.overlapRight;
    for (let j = 0; j < HOP_LEN; j++) {
      this.fifoLeft[j] = overlapLeft[j] as number;
      this.fifoRight[j] = overlapRight[j] as number;
    }
    overlapLeft.copyWithin(0, HOP_LEN, FRAME_LEN);
    overlapRight.copyWithin(0, HOP_LEN, FRAME_LEN);
    overlapLeft.fill(0, HOP_LEN, FRAME_LEN);
    overlapRight.fill(0, HOP_LEN, FRAME_LEN);
    this.fifoReadIndex = 0;
  }

  // ---- Key lock: the similarity search ----

  /**
   * The offset in the region (0…2·SEARCH_RADIUS, SEARCH_RADIUS = the nominal place) whose first half-frame best continues
   * the frame before: normalized cross-correlation with the part of the previous frame that is still to be heard, a
   * coarse pass on a 4× decimated mono mix, then ±4 frames at full rate, with a small cost for moving away from the middle.
   */
  private search(low: number, high: number): number {
    this.readRange(this.templateLeft, this.templateRight, this.previousFrameStart + HOP_LEN, HOP_LEN);
    this.downmixRegionAndTemplate();
    const coarseIndex = this.searchCoarse(low, high);
    return this.searchFine(coarseIndex, low, high);
  }

  /** Mono mixes of the region and of the template, each also decimated by averaging groups of `SEARCH_DECIMATION`. */
  private downmixRegionAndTemplate(): void {
    const regionMono = this.regionMono;
    const regionMonoDecimated = this.regionMonoDecimated;
    const templateMono = this.templateMono;
    const templateMonoDecimated = this.templateMonoDecimated;
    const regionLeft = this.regionLeft;
    const regionRight = this.regionRight;
    for (let i = 0; i < REGION_LEN; i++) regionMono[i] = 0.5 * ((regionLeft[i] as number) + (regionRight[i] as number));
    for (let m = 0; m < REGION_LEN_DECIMATED; m++) {
      const b = m * SEARCH_DECIMATION;
      regionMonoDecimated[m] = 0.25 * ((regionMono[b] as number) + (regionMono[b + 1] as number) + (regionMono[b + 2] as number) + (regionMono[b + 3] as number));
    }
    for (let i = 0; i < HOP_LEN; i++) templateMono[i] = 0.5 * ((this.templateLeft[i] as number) + (this.templateRight[i] as number));
    for (let m = 0; m < TEMPLATE_LEN_DECIMATED; m++) {
      const b = m * SEARCH_DECIMATION;
      templateMonoDecimated[m] = 0.25 * ((templateMono[b] as number) + (templateMono[b + 1] as number) + (templateMono[b + 2] as number) + (templateMono[b + 3] as number));
    }
  }

  /** Coarse pass: candidates every 4 frames across the range (the whole ±radius, or less for a frame that must land on time). Returns the best candidate's index (in decimated frames). */
  private searchCoarse(low: number, high: number): number {
    const region = this.regionMonoDecimated;
    const template = this.templateMonoDecimated;
    let templateEnergy = 1e-9;
    for (let i = 0; i < TEMPLATE_LEN_DECIMATED; i++) templateEnergy += (template[i] as number) * (template[i] as number);
    const firstIndex = Math.ceil(low / SEARCH_DECIMATION);
    const lastIndex = Math.floor(high / SEARCH_DECIMATION);
    // The energy of the region under the template, slid along by adding the sample that enters and dropping the one that leaves.
    let regionEnergy = 1e-9;
    for (let i = 0; i < TEMPLATE_LEN_DECIMATED; i++) regionEnergy += (region[firstIndex + i] as number) * (region[firstIndex + i] as number);
    let bestIndex = Math.round(SEARCH_RADIUS / SEARCH_DECIMATION);
    let bestScore = -Infinity;
    const middle = SEARCH_RADIUS / SEARCH_DECIMATION;
    for (let index = firstIndex; index <= lastIndex; index++) {
      let correlation = 0;
      for (let i = 0; i < TEMPLATE_LEN_DECIMATED; i++) correlation += (template[i] as number) * (region[index + i] as number);
      const score = correlation / Math.sqrt(regionEnergy * templateEnergy) - (CENTER_BIAS * Math.abs(index - middle)) / middle;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
      const leaving = region[index] as number;
      const entering = region[index + TEMPLATE_LEN_DECIMATED] as number;
      regionEnergy += entering * entering - leaving * leaving;
      if (regionEnergy < 1e-9) regionEnergy = 1e-9;
    }
    return bestIndex;
  }

  /** Fine pass: ±`SEARCH_DECIMATION` frames around the coarse winner at full rate. Returns the best offset in the region. */
  private searchFine(coarseIndex: number, low: number, high: number): number {
    const region = this.regionMono;
    const template = this.templateMono;
    let templateEnergy = 1e-9;
    for (let i = 0; i < HOP_LEN; i++) templateEnergy += (template[i] as number) * (template[i] as number);
    let best = coarseIndex * SEARCH_DECIMATION;
    let bestScore = -Infinity;
    const first = Math.max(low, coarseIndex * SEARCH_DECIMATION - SEARCH_DECIMATION);
    const last = Math.min(high, coarseIndex * SEARCH_DECIMATION + SEARCH_DECIMATION);
    for (let offset = first; offset <= last; offset++) {
      let correlation = 0;
      let regionEnergy = 1e-9;
      for (let i = 0; i < HOP_LEN; i++) {
        const v = region[offset + i] as number;
        correlation += (template[i] as number) * v;
        regionEnergy += v * v;
      }
      const score = correlation / Math.sqrt(regionEnergy * templateEnergy) - (CENTER_BIAS * Math.abs(offset - SEARCH_RADIUS)) / SEARCH_RADIUS;
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }
    return best;
  }

  // ---- Sync ----

  /** Follows the master's tempo and beat phase for this render quantum. */
  private updateSync(frame: number, n: number): void {
    const sync = this.sync;
    this.effectiveTempo = this.tempo;
    if (!sync) return;
    const master = this.masterSnapshot;
    readDeckState(sync.state, sync.seq, master);
    if (master.stalled && this.playing) {
      // The master waits for audio: it will come back somewhere else on its beat; land on it then.
      this.syncLocked = false;
      this.syncError = 0;
      this.alignPending = true;
      this.alignWaitFrames = Math.round(ALIGN_WAIT_AFTER_STALL_SEC * this.sampleRate);
      return;
    }
    if (!master.playing || master.tempoRate <= 0) {
      this.syncLocked = false;
      this.syncError = 0;
      // A follower started together with its master waits a moment for it to start.
      if (this.alignPending && (this.alignWaitFrames -= n) <= 0) this.alignPending = false;
      return;
    }
    const spec = sync.spec;
    const selfMap = sync.selfMap;
    const masterMap = sync.masterMap;
    // The master's position at the first frame of this quantum.
    const masterPos = master.pos + (frame - master.frame) * master.rate;
    // Tracked beats on either side: the tempo ratio is the one of the beats here and there (it moves as the songs drift),
    // and the phase counts the beats of each. Fixed grids on both sides keep the one ratio.
    const multiple = spec.selfMult ?? 1;
    const selfBeatLen = selfMap ? selfMap.lenAt(this.pos) / multiple : spec.selfBeat;
    const hasTrackedBeats = selfMap || masterMap;
    this.effectiveTempo = hasTrackedBeats
      ? (selfBeatLen / (masterMap ? masterMap.lenAt(masterPos) : spec.masterBeat)) * master.tempoRate
      : spec.ratio * master.tempoRate;
    this.syncLocked = true;
    if (!this.playing || master.scratching) {
      this.syncError = 0;
      return;
    }
    const masterPhase = masterMap ? masterMap.beatAt(masterPos) : (masterPos - spec.masterFirst) / spec.masterBeat;
    const selfPhase = selfMap ? selfMap.beatAt(this.pos) * multiple : (this.pos - spec.selfFirst) / spec.selfBeat;
    // The phase error in beats, wrapped to the nearest beat (a follower a whole beat off is in phase).
    let phaseError = selfPhase - masterPhase;
    phaseError -= Math.round(phaseError);
    this.syncError = phaseError;
    if (this.alignPending) {
      this.alignToMaster(sync, selfPhase, phaseError, multiple);
      return;
    }
    // Close the error gently: a small tempo trim, so the phase glides in instead of jumping.
    const secPerBeat = selfBeatLen / (this.sampleRate * Math.max(MIN_SYNC_RATE, this.currentRate));
    const trim = clamp((-phaseError * secPerBeat) / SYNC_TIME_CONSTANT_SEC, -MAX_SYNC_TRIM, MAX_SYNC_TRIM);
    this.effectiveTempo *= 1 + trim;
  }

  /** Jumps to the master's beat now (a start, a sync press, a master that jumped); the phase lock does the rest. */
  private alignToMaster(sync: SyncState, selfPhase: number, phaseError: number, multiple: number): void {
    this.alignPending = false;
    // The master may be mid-jump (its position is a quantum old): align only when it is steady is not
    // knowable here, so just land on its beat now.
    if (!this.startingFromSilence) this.captureTail();
    const landing = sync.selfMap ? sync.selfMap.posAt((selfPhase - phaseError) / multiple) : this.pos - phaseError * sync.spec.selfBeat;
    this.pos = clamp(landing, 0, this.frames);
    this.resetStretch();
    if (this.isRunning) this.fadeInFramesLeft = this.declickFrames;
    this.syncError = 0;
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
    state[DS.tempoRate] = this.playing ? this.effectiveTempo * (1 + this.nudgeCurrent) : 0;
    state[DS.playing] = isRunning ? 1 : 0;
    state[DS.scratching] = this.scratching ? 1 : 0;
    state[DS.loopWraps] = this.loopWraps;
    state[DS.syncError] = this.syncError;
    state[DS.syncLocked] = this.syncLocked ? 1 : 0;
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
