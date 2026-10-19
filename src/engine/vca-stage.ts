/**
 * The VCA of a mixer strip: one gain between the fader and the strip's post-fader tap,
 *
 *   panner → fader → [vca] → postTap
 *
 * so the group's level scales the strip's sound, its post-fader sends and its meter, and leaves the fader, the pre-fader
 * sends and the sidechain tap alone. It adds no latency and costs one gain, and a strip whose group has no VCA has no
 * such node at all (its path, and so every render of a project without VCAs, is exactly what it was).
 *
 * Each member strip has its own lane for the group's level, registered under the group's target key (`vca:<groupId>`),
 * because each strip sits a different delay-compensation time behind the song's clock: automation of the VCA reaches
 * every member at the time its own fader would hear it. Several lanes under one key is what the registry is for.
 */
import { VCA_SPEC } from '@core/model/target-specs';
import { targetKey } from '@core/model/targets';
import type { GroupId } from '@core/model/types';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { clampOrFallback, disconnectFrom } from './audio-graph';
import type { EngineCore } from './engine-core';
import { AutoLane } from './param-lane';

/** Time constant of VCA moves (seconds; matches faders). */
const VCA_GLIDE_TAU_SEC = 0.004;

/** The VCA gain of one strip (see the file comment). */
export class VcaStage {
  /** Made the first time the strip's group has a VCA, then kept (at unity) so taking the VCA away never clicks. */
  private node: GainNode | null = null;
  private lane: AutoLane | null = null;
  private unregister: (() => void) | null = null;
  private groupId: GroupId | null = null;
  /** Seconds the strip's output sits behind the song's clock (set by the mixer's delay compensation). */
  private shift = 0;

  constructor(
    private readonly core: EngineCore,
    private readonly fader: AudioNode,
    private readonly postTap: AudioNode,
  ) {}

  /** True while a lane drives the gain. */
  get active(): boolean {
    return this.lane !== null;
  }

  /**
   * The strip's group now has a VCA at `level` (linear gain), or none (`groupId` null). A level change glides over
   * `glideTau` seconds (default: the fader's); joining a VCA glides from unity, leaving one glides back to unity.
   */
  set(groupId: GroupId | null, level: number, glideTau: number = VCA_GLIDE_TAU_SEC): void {
    const now = this.core.ctx.currentTime;
    if (groupId !== null && groupId === this.groupId && this.lane) {
      const next = clampOrFallback(level, 0, MAX_INSERT_VOLUME);
      if (next !== this.lane.base) this.lane.setBase(next, now, glideTau);
      return;
    }
    this.release(now, glideTau);
    if (groupId === null) return;
    this.engage(groupId, clampOrFallback(level, 0, MAX_INSERT_VOLUME), glideTau);
  }

  /** The strip's output follows the song's clock `seconds` late, and so does its VCA automation. */
  setShift(seconds: number): void {
    this.shift = seconds;
    if (this.lane) this.lane.shift = seconds;
  }

  dispose(): void {
    this.unregister?.();
    this.lane?.dispose();
    this.lane = null;
    if (this.node) {
      disconnectFrom(this.fader, this.node);
      this.node.disconnect();
      this.node = null;
    }
  }

  /** Puts the gain in the path (once), binds a fresh lane to it and glides it to `level`. */
  private engage(groupId: GroupId, level: number, glideTau: number): void {
    const ctx = this.core.ctx;
    if (!this.node) {
      this.node = new GainNode(ctx);
      // The new path is made before the old one goes: the signal never stops.
      this.fader.connect(this.node);
      this.node.connect(this.postTap);
      disconnectFrom(this.fader, this.postTap);
    }
    const lane = new AutoLane(ctx, targetKey({ kind: 'vca', groupId }), VCA_SPEC, 1, VCA_GLIDE_TAU_SEC);
    lane.shift = this.shift;
    lane.bind(this.node.gain);
    this.unregister = this.core.params.register(lane);
    this.lane = lane;
    this.groupId = groupId;
    if (level !== 1) lane.setBase(level, ctx.currentTime, glideTau);
  }

  /** Lets go of the group's lane: the gain glides back to unity and stays in the path. */
  private release(now: number, glideTau: number): void {
    const lane = this.lane;
    if (!lane) return;
    lane.setBase(1, now, glideTau);
    this.unregister?.();
    lane.dispose();
    this.lane = null;
    this.unregister = null;
    this.groupId = null;
  }
}
