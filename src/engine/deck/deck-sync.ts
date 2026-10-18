/**
 * A deck following another (sync): every render quantum it reads the master's published position and speed (shared
 * memory) and works out what tempo it must run at to hold the master's tempo and beat phase, and when to jump onto the
 * master's beat. It never allocates after `set`; the deck kernel (`deck.kernel.ts`) applies the results.
 */
import { BeatMap } from '@core/dj/beat-map';
import type { SyncSpec } from './deck-id';
import { newSnapshot, readDeckState } from './deck-snapshot';

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

/** The link to a master: the spec it was given and the shared state it reads. */
interface MasterLink {
  spec: SyncSpec;
  state: Float64Array;
  seq: Int32Array;
  /** The beat clocks of the two songs when they have tracked beats (null: the fixed grid in `spec`). */
  selfMap: BeatMap | null;
  masterMap: BeatMap | null;
}

/** The sync of one deck to its master. */
export class SyncFollower {
  private link: MasterLink | null = null;
  private readonly masterSnapshot = newSnapshot();
  /** Jump to the master's beat at the next quantum (a start, a sync press, the master jumped). */
  private alignPending = false;
  /** Frames a pending align waits for a master that isn't playing yet (a follower started together with it). */
  private alignWaitFrames = 0;

  /** The tempo the deck runs at: its own, or the master's matched (and trimmed to close the beat-phase error) when following. */
  effectiveTempo = 1;
  /** The deck is locked to a playing master. */
  isLocked = false;
  /** The beat-phase error to the master in beats (positive = ahead); 0 when not following. */
  phaseError = 0;

  constructor(private readonly sampleRate: number) {}

  /** Whether the deck follows a master (locked or not). */
  get isFollowing(): boolean {
    return this.link !== null;
  }

  /** Follows the master in `spec`, or (null) nobody. */
  set(spec: SyncSpec | null): void {
    if (!spec) {
      this.link = null;
      this.isLocked = false;
      this.phaseError = 0;
      return;
    }
    this.alignPending = false;
    this.link = {
      spec,
      state: new Float64Array(spec.master),
      seq: new Int32Array(spec.master, 0, 1),
      selfMap: beatMapOf(spec.selfBeats, spec.selfFirst),
      masterMap: beatMapOf(spec.masterBeats, spec.masterFirst),
    };
  }

  /** Moves the deck to the master's beat at the next render quantum (it does so by itself when it starts). */
  requestAlign(): void {
    this.alignPending = true;
    this.alignWaitFrames = Math.round(ALIGN_WAIT_SEC * this.sampleRate);
  }

  /**
   * Follows the master's tempo and beat phase for this render quantum (`frame` is the context frame of its first frame,
   * `n` its length). `tempo`, `isPlaying`, `pos` and `rate` are the deck's own. Returns the song frame to jump to now
   * to land on the master's beat (not clamped), or null.
   */
  update(frame: number, n: number, tempo: number, isPlaying: boolean, pos: number, rate: number): number | null {
    const link = this.link;
    this.effectiveTempo = tempo;
    if (!link) return null;
    const master = this.masterSnapshot;
    readDeckState(link.state, link.seq, master);
    if (master.stalled && isPlaying) {
      // The master waits for audio: it will come back somewhere else on its beat; land on it then.
      this.isLocked = false;
      this.phaseError = 0;
      this.alignPending = true;
      this.alignWaitFrames = Math.round(ALIGN_WAIT_AFTER_STALL_SEC * this.sampleRate);
      return null;
    }
    if (!master.playing || master.tempoRate <= 0) {
      this.isLocked = false;
      this.phaseError = 0;
      // A follower started together with its master waits a moment for it to start.
      if (this.alignPending && (this.alignWaitFrames -= n) <= 0) this.alignPending = false;
      return null;
    }
    const spec = link.spec;
    const selfMap = link.selfMap;
    const masterMap = link.masterMap;
    // The master's position at the first frame of this quantum.
    const masterPos = master.pos + (frame - master.frame) * master.rate;
    // Tracked beats on either side: the tempo ratio is the one of the beats here and there (it moves as the songs drift),
    // and the phase counts the beats of each. Fixed grids on both sides keep the one ratio.
    const multiple = spec.selfMult ?? 1;
    const selfBeatLen = selfMap ? selfMap.lenAt(pos) / multiple : spec.selfBeat;
    const hasTrackedBeats = selfMap || masterMap;
    this.effectiveTempo = hasTrackedBeats
      ? (selfBeatLen / (masterMap ? masterMap.lenAt(masterPos) : spec.masterBeat)) * master.tempoRate
      : spec.ratio * master.tempoRate;
    this.isLocked = true;
    if (!isPlaying || master.scratching) {
      this.phaseError = 0;
      return null;
    }
    const masterPhase = masterMap ? masterMap.beatAt(masterPos) : (masterPos - spec.masterFirst) / spec.masterBeat;
    const selfPhase = selfMap ? selfMap.beatAt(pos) * multiple : (pos - spec.selfFirst) / spec.selfBeat;
    // The phase error in beats, wrapped to the nearest beat (a follower a whole beat off is in phase).
    let error = selfPhase - masterPhase;
    error -= Math.round(error);
    this.phaseError = error;
    if (this.alignPending) {
      this.alignPending = false;
      // The master may be mid-jump (its position is a quantum old): align only when it is steady is not
      // knowable here, so just land on its beat now; the phase lock does the rest.
      this.phaseError = 0;
      return selfMap ? selfMap.posAt((selfPhase - error) / multiple) : pos - error * spec.selfBeat;
    }
    // Close the error gently: a small tempo trim, so the phase glides in instead of jumping.
    const secPerBeat = selfBeatLen / (this.sampleRate * Math.max(MIN_SYNC_RATE, rate));
    const trim = clamp((-error * secPerBeat) / SYNC_TIME_CONSTANT_SEC, -MAX_SYNC_TRIM, MAX_SYNC_TRIM);
    this.effectiveTempo *= 1 + trim;
    return null;
  }
}
