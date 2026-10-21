/**
 * One branch of a rack:
 *
 *   feed ─► head ─► slot 1 … slot N ─► tail (mute/solo gate) ─► [alignment delay] ─► level ─► pan ─► the rack's sum
 *
 * The effects are a `SlotChain`. The alignment delay is as long as the branch is quicker than the slowest one, so
 * the branches add up in time (it exists only while it is needed). A branch that does not sound (muted, or left out by a
 * solo) is cut off at both ends once its fade is over, so its effects are not processed at all.
 */
import { BRANCH_LEVEL_MIN_DB } from '@core/model/rack';
import { BRANCH_LEVEL_SPEC, BRANCH_PAN_SPEC } from '@core/rack/mapping';
import type { InsertId, PluginOwner, Project, RackBranch } from '@core/model/types';
import { dbToGain } from '@agstudio/sdk';
import { clampOrFallback, disconnectFrom, glide } from '../audio-graph';
import type { EngineCore } from '../engine-core';
import type { SlotHooks, SlotIdleNeeds } from '../fx-slot-strip';
import { AutoLane } from '../param-lane';
import { SlotChain } from '../slot-chain';

/** Time constant of the mute/solo gate and of level and pan moves (seconds): three of them make about a 10 ms fade. */
const BRANCH_GLIDE_TAU_SEC = 0.01 / 3;
/** How long a branch that went silent stays connected, so its fade-out is over before it is cut off. */
const CUT_OFF_DELAY_MS = 60;
/** Alignment delays are made with room to grow by this factor, so a small change in latency retimes the same delay. */
const DELAY_HEADROOM = 2;
/** The least room (seconds) an alignment delay is made with. */
const MIN_DELAY_ROOM_SEC = 0.05;

/** A level in dB as a linear gain; the lowest level is silence. */
export const levelToGain = (db: number): number => (db <= BRANCH_LEVEL_MIN_DB ? 0 : dbToGain(db));

/** What a branch needs to be made. */
export interface BranchOptions {
  core: EngineCore;
  insertId: InsertId;
  /** The rack slot's owner (effects inside run as full processors while its macros are automated). */
  parentOwner: PluginOwner;
  /** `<insert>:<rack slot>:<branch>`, so lanes of different branches have different keys. */
  keyPrefix: string;
  data: RackBranch;
  project: Project;
  hooks: SlotHooks;
  /** The chain's latency (or what listens in it) changed. */
  onLatency: () => void;
}

/** One branch of a rack (see the file comment). */
export class Branch {
  /** What the split feeds. */
  readonly head: GainNode;
  readonly chain: SlotChain;
  /** The end of the chain, and the mute/solo gate. */
  private readonly tail: GainNode;
  private delay: DelayNode | null = null;
  private delayRoomFrames = 0;
  private readonly level: GainNode;
  private readonly panner: StereoPannerNode;
  /** The branch's last node: what joins the rack's sum. */
  readonly output: AudioNode;
  readonly levelLane: AutoLane;
  readonly panLane: AutoLane;
  private data: RackBranch;
  private isAudible = true;
  /** The rack is parked (its insert stopped processing it); the branch's chain is parked while it is, or while it is silent. */
  private isRackParked = false;
  /** Disconnects the head from its feed, and the output from the sum (null while cut off). */
  private connections: { feed: AudioNode; unjoin: () => void } | null = null;
  private cutOffTimer: ReturnType<typeof setTimeout> | null = null;
  private alignmentFrames = 0;

  constructor(private readonly options: BranchOptions) {
    const { core, data } = options;
    const ctx = core.ctx;
    this.data = data;
    this.head = new GainNode(ctx);
    this.tail = new GainNode(ctx);
    this.level = new GainNode(ctx);
    this.panner = new StereoPannerNode(ctx);
    this.output = this.panner;
    this.tail.connect(this.level).connect(this.panner);
    this.levelLane = new AutoLane(
      ctx,
      `rack:${options.keyPrefix}:${data.id}:level`,
      BRANCH_LEVEL_SPEC,
      clampOrFallback(data.levelDb, BRANCH_LEVEL_SPEC.min, BRANCH_LEVEL_SPEC.max, 0),
      BRANCH_GLIDE_TAU_SEC,
    );
    this.panLane = new AutoLane(ctx, `rack:${options.keyPrefix}:${data.id}:pan`, BRANCH_PAN_SPEC, clampOrFallback(data.pan, -1, 1, 0), BRANCH_GLIDE_TAU_SEC);
    this.levelLane.bind(this.level.gain, levelToGain);
    this.panLane.bind(this.panner.pan);
    this.chain = new SlotChain({
      core,
      insertId: options.insertId,
      head: this.head,
      sink: this.tail,
      onLatency: options.onLatency,
      parentOwner: options.parentOwner,
      hooks: options.hooks,
    });
    this.chain.sync(data.fx, options.project);
  }

  get id(): RackBranch['id'] {
    return this.data.id;
  }

  /** Frames of latency the branch's live effects add. */
  get latencyFrames(): number {
    return this.chain.latencyFrames;
  }

  /** Whether the branch sounds now (not muted and not left out by a solo). */
  get audible(): boolean {
    return this.isAudible;
  }

  /** Brings the branch in line with the document (its effects too). */
  update(data: RackBranch, project: Project): void {
    const prev = this.data;
    this.data = data;
    const now = this.options.core.ctx.currentTime;
    if (prev.levelDb !== data.levelDb) this.levelLane.setBase(clampOrFallback(data.levelDb, BRANCH_LEVEL_SPEC.min, BRANCH_LEVEL_SPEC.max, 0), now);
    if (prev.pan !== data.pan) this.panLane.setBase(clampOrFallback(data.pan, -1, 1, 0), now);
    if (prev.fx !== data.fx) this.chain.sync(data.fx, project);
  }

  /**
   * Connects the branch between its feed and the sum, or cuts it off (a branch that does not sound). A branch that goes
   * silent fades out first and is cut off when the fade is over; one that comes back is connected at once, then fades in.
   */
  connect(feed: AudioNode, join: (output: AudioNode) => () => void, audible: boolean): void {
    this.isAudible = audible;
    if (this.cutOffTimer) clearTimeout(this.cutOffTimer);
    this.cutOffTimer = null;
    if (audible) {
      if (!this.connections || this.connections.feed !== feed) {
        this.disconnect();
        feed.connect(this.head);
        this.connections = { feed, unjoin: join(this.output) };
      }
      this.syncChainParking();
      glide(this.tail.gain, 1, this.options.core.ctx, BRANCH_GLIDE_TAU_SEC);
      return;
    }
    glide(this.tail.gain, 0, this.options.core.ctx, BRANCH_GLIDE_TAU_SEC);
    if (this.isBeforeStart) {
      this.cutOff();
      return;
    }
    this.cutOffTimer = setTimeout(() => {
      this.cutOffTimer = null;
      this.cutOff();
    }, CUT_OFF_DELAY_MS);
  }

  /** Disconnects the branch from its feed and from the sum, without parking it (the rack is rebuilding its split). */
  disconnect(): void {
    if (!this.connections) return;
    disconnectFrom(this.connections.feed, this.head);
    this.connections.unjoin();
    this.connections = null;
  }

  /** The delay that holds this branch back so it lines up with the slowest one: `frames` long (0 = none). */
  setAlignment(frames: number): void {
    if (frames === this.alignmentFrames) return;
    this.alignmentFrames = frames;
    const ctx = this.options.core.ctx;
    if (frames <= 0) {
      this.removeDelay();
      return;
    }
    if (!this.delay || frames > this.delayRoomFrames) {
      this.removeDelay();
      this.delayRoomFrames = Math.max(Math.ceil(frames * DELAY_HEADROOM), Math.ceil(MIN_DELAY_ROOM_SEC * ctx.sampleRate));
      this.delay = new DelayNode(ctx, { maxDelayTime: this.delayRoomFrames / ctx.sampleRate, delayTime: frames / ctx.sampleRate });
      this.tail.disconnect();
      this.tail.connect(this.delay).connect(this.level);
      return;
    }
    // The same delay, set again: Chrome delays by exactly n frames at n / sampleRate.
    const now = ctx.currentTime;
    this.delay.delayTime.cancelScheduledValues(0);
    this.delay.delayTime.setValueAtTime(frames / ctx.sampleRate, now);
  }

  /** Where the branch's output is, in frames after the song's clock, once the rack's audio arrives `arrivalFrames` late. */
  setAlignedShift(arrivalFrames: number, outFrames: number): void {
    const sampleRate = this.options.core.ctx.sampleRate;
    this.chain.setAlignment(arrivalFrames);
    this.levelLane.shift = outFrames / sampleRate;
    this.panLane.shift = outFrames / sampleRate;
  }

  /** The rack's insert stopped or resumed processing the rack. */
  setParked(isParked: boolean): void {
    this.isRackParked = isParked;
    this.syncChainParking();
  }

  /** What the branch needs before the insert may park: nothing while it is silent (nothing in it is processed). */
  idleNeeds(): SlotIdleNeeds {
    return this.isAudible ? this.chain.idleNeeds() : { busy: false, tailSec: 0 };
  }

  /** Seconds the branch's effects ring after their input stops. */
  get tailTime(): number {
    return this.chain.tailTime;
  }

  dispose(): void {
    if (this.cutOffTimer) clearTimeout(this.cutOffTimer);
    this.cutOffTimer = null;
    this.disconnect();
    this.chain.dispose();
    this.levelLane.dispose();
    this.panLane.dispose();
    this.delay?.disconnect();
    for (const node of [this.tail, this.level, this.panner]) node.disconnect();
  }

  /** The chain is parked while the rack is, and while the branch is cut off. */
  private syncChainParking(): void {
    const shouldPark = this.isRackParked || !this.isAudible;
    if (shouldPark) this.chain.park();
    else this.chain.unpark();
  }

  private cutOff(): void {
    this.disconnect();
    this.syncChainParking();
  }

  private removeDelay(): void {
    if (!this.delay) return;
    this.tail.disconnect();
    this.delay.disconnect();
    this.delay = null;
    this.delayRoomFrames = 0;
    this.tail.connect(this.level);
  }

  private get isBeforeStart(): boolean {
    return this.options.core.offline || this.options.core.ctx.currentTime === 0;
  }
}
