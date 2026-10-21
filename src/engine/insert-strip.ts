/**
 * A mixer insert (the master uses the same strip). The insert's persistent nodes (its taps, see
 * engine/mixer-graph.ts) belong to the mixer graph; a strip wires its own nodes between them:
 *
 *   routeIn → slot 1 … slot N → scTap → [gate (mute/solo)] → preTap → StereoPanner → fader → [vca] → postTap
 *                                                                        (meters: ChannelSplitter → 2× AnalyserNode, only while read)
 *
 * The effect slots are a `SlotChain` (engine/slot-chain.ts) of `FxSlotStrip`s (engine/fx-slot-strip.ts). Reordering slots only rewires the chain. The `[vca]` gain
 * exists only while the strip's mixer group has a VCA (engine/vca-stage.ts), and the `[gate]` from the first time the
 * insert is muted (a gain at 1 does nothing but cost the audio thread time on every block, and most inserts are never muted).
 */
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import type { GroupId } from '@core/model/types';
import { INSERT_PAN_SPEC, INSERT_VOLUME_SPEC } from '@core/model/target-specs';
import { targetKey } from '@core/model/targets';
import type { Insert, InsertId, Project } from '@core/model/types';
import { clampOrFallback, disconnectFrom, glide } from './audio-graph';
import type { EngineCore } from './engine-core';
import type { FxSlotStrip, SlotIdleNeeds } from './fx-slot-strip';
import { InsertMeters } from './insert-meters';
import type { MeterScratch } from './meter-peak';
import { AutoLane } from './param-lane';
import { SlotChain } from './slot-chain';
import { VcaStage } from './vca-stage';

/** Time constant for fader/pan/mute moves (matches channel strips). */
const STRIP_GLIDE_TAU_SEC = 0.004;

/** A glide of `glideSec` seconds as a time constant: the value is within 2% of its target after four of them. */
const GLIDE_TIME_CONSTANTS = 4;
const glideTau = (glideSec: number): number => (glideSec > 0 ? glideSec / GLIDE_TIME_CONSTANTS : STRIP_GLIDE_TAU_SEC);

/** The persistent nodes of an insert that its strip connects between (owned by the mixer graph). */
export interface InsertTaps {
  /** Head of the effect chain: routes (and the padded channel input) land here. */
  readonly routeIn: GainNode;
  /** After the effects, before the mute/solo gate: the insert's sidechain output. */
  readonly scTap: GainNode;
  /** After the gate, before pan and fader: pre-fader sends. */
  readonly preTap: GainNode;
  /** After the fader: post-fader sends, the meters (and the master bus, for the master). */
  readonly postTap: GainNode;
}

/** A mixer insert (the master uses the same strip). */
export class InsertStrip {
  /** The mute/solo gate; null until the insert is first muted (see the file comment). */
  private gate: GainNode | null = null;
  private readonly panner: StereoPannerNode;
  private readonly fader: GainNode;
  private readonly meters: InsertMeters;
  private readonly vca: VcaStage;
  /** The effect slots, from routeIn to the sidechain tap. */
  private readonly chain: SlotChain;
  private insert: Insert;
  private muted = false;
  private readonly volumeLane: AutoLane;
  private readonly panLane: AutoLane;
  private readonly unregisterLanes: (() => void)[];

  constructor(
    private readonly core: EngineCore,
    insert: Insert,
    project: Project | null,
    readonly taps: InsertTaps,
    /** Called when the latency of the chain (or what listens to a sidechain in it) changes. */
    private readonly onLatency: () => void = () => {},
  ) {
    const ctx = core.ctx;
    this.insert = insert;
    this.chain = new SlotChain({ core, insertId: insert.id, head: taps.routeIn, sink: taps.scTap, onLatency });
    this.panner = new StereoPannerNode(ctx);
    this.fader = new GainNode(ctx);
    this.meters = new InsertMeters(ctx, taps.postTap, core.offline);
    const key = (param: 'volume' | 'pan') => targetKey({ kind: 'insert', insertId: insert.id, param });
    this.volumeLane = new AutoLane(
      ctx,
      key('volume'),
      INSERT_VOLUME_SPEC,
      clampOrFallback(insert.volume, 0, MAX_INSERT_VOLUME),
      STRIP_GLIDE_TAU_SEC,
    );
    this.panLane = new AutoLane(ctx, key('pan'), INSERT_PAN_SPEC, clampOrFallback(insert.pan, -1, 1, 0), STRIP_GLIDE_TAU_SEC);
    this.volumeLane.bind(this.fader.gain);
    this.panLane.bind(this.panner.pan);
    this.unregisterLanes = [core.params.register(this.volumeLane), core.params.register(this.panLane)];
    taps.scTap.connect(taps.preTap);
    taps.preTap.connect(this.panner);
    this.panner.connect(this.fader);
    this.fader.connect(taps.postTap);
    this.vca = new VcaStage(core, this.fader, taps.postTap);
    if (project) this.chain.sync(insert.fx, project);
  }

  get id(): InsertId {
    return this.insert.id;
  }

  /** Resolves when every effect of the chain has been created. */
  get ready(): Promise<void> {
    return this.chain.ready;
  }

  /** Seconds of tail added by this insert's effects (they run in series). */
  get tailTime(): number {
    return this.chain.tailTime;
  }

  /** The effect slots in chain order. */
  get slotStrips(): readonly FxSlotStrip[] {
    return this.chain.slotStrips;
  }

  /** The effect chain is out of the audio graph (see park()). */
  get parked(): boolean {
    return this.chain.parked;
  }

  /**
   * What the chain needs before it may be parked: every effect that reports its sleep is asleep, and the ones that
   * cannot say so have had silence at the input for as long as they ring (`tailSec`, the sum for effects in series:
   * an echo can leave one effect after another has gone quiet).
   */
  idleNeeds(): SlotIdleNeeds {
    return this.chain.idleNeeds();
  }

  /**
   * Cuts the effect chain off from the sidechain tap while nothing can sound in it. The browser pulls audio from the
   * destination backwards through connections, so with the last effect connected to nothing the whole chain (the
   * routes' padded inputs, the slots' gates, every effect) is no longer processed; the tap, the fader and everything
   * after it keep running on silence, which costs next to nothing. Idle parking decides when (engine/idle-parking.ts).
   */
  park(): void {
    this.chain.park();
  }

  /** Puts the chain back between the effects' input and the sidechain tap. */
  unpark(): void {
    this.chain.unpark();
  }

  /**
   * The audio entering this insert is `arrivalFrames` behind the time the song schedules it (delay compensation: see
   * pdc.ts). Each slot's params follow what reaches it, and the fader and pan follow what leaves the last slot.
   */
  setAlignment(arrivalFrames: number): void {
    const sampleRate = this.core.ctx.sampleRate;
    const at = this.chain.setAlignment(arrivalFrames);
    this.volumeLane.shift = at / sampleRate;
    this.panLane.shift = at / sampleRate;
    this.vca.setShift(at / sampleRate);
  }

  /** `glideSec` > 0 (a snapshot recall): the fader and pan glide over that long instead of the usual few milliseconds. */
  update(next: Insert, project: Project, glideSec = 0): void {
    const prev = this.insert;
    if (prev === next) return;
    this.insert = next;
    const now = this.core.ctx.currentTime;
    const tau = glideTau(glideSec);
    if (prev.volume !== next.volume) this.volumeLane.setBase(clampOrFallback(next.volume, 0, MAX_INSERT_VOLUME), now, tau);
    if (prev.pan !== next.pan) this.panLane.setBase(clampOrFallback(next.pan, -1, 1, 0), now, tau);
    if (prev.fx !== next.fx) this.chain.sync(next.fx, project);
  }

  samplesChanged(project: Project): void {
    this.chain.samplesChanged(project);
  }

  /** The set of automated plugin instances changed (see FxSlotStrip.automationChanged). */
  automationChanged(project: Project): void {
    this.chain.automationChanged(project);
  }

  /** Rebuilds effects whose plugin definition changed (hot reload, install/uninstall). */
  pluginsChanged(ids: ReadonlySet<string>, project: Project): void {
    this.chain.pluginsChanged(ids, project);
  }

  /** Puts the gate between the sidechain tap and the pre-fader tap (at gain 1, so nothing changes until it moves). */
  private ensureGate(): GainNode {
    if (this.gate) return this.gate;
    const gate = new GainNode(this.core.ctx);
    disconnectFrom(this.taps.scTap, this.taps.preTap);
    this.taps.scTap.connect(gate);
    gate.connect(this.taps.preTap);
    this.gate = gate;
    return gate;
  }

  /** The mute/solo gate (after the effects, so pre-fader sends are muted too; the sidechain tap isn't). */
  setMuted(muted: boolean, glideSec = 0): void {
    if (muted === this.muted) return;
    this.muted = muted;
    glide(this.ensureGate().gain, muted ? 0 : 1, this.core.ctx, glideTau(glideSec));
  }

  /** The strip's group has a VCA at `level` (linear gain), or none (`groupId` null): see engine/vca-stage.ts. */
  setVca(groupId: GroupId | null, level: number, glideSec = 0): void {
    this.vca.set(groupId, level, glideTau(glideSec));
  }

  /**
   * Writes the left/right peak of the last METER_FRAMES frames into out[at], out[at + 1]. The meter
   * analysers only exist while someone reads them: the first read connects them and reads 0 (see InsertMeters).
   */
  readPeaks(scratch: MeterScratch, out: Float32Array, at: number): void {
    this.meters.readPeaks(scratch, out, at);
  }

  /** True while the meter analysers are in the graph (diagnostics and tests). */
  get metering(): boolean {
    return this.meters.active;
  }

  dispose(): void {
    this.chain.dispose();
    for (const unregister of this.unregisterLanes) unregister();
    this.volumeLane.dispose();
    this.panLane.dispose();
    this.vca.dispose();
    // Only the strip's own connections: the taps' sends belong to the mixer graph.
    disconnectFrom(this.taps.scTap, this.gate ?? this.taps.preTap);
    disconnectFrom(this.taps.preTap, this.panner);
    this.meters.drop();
    this.gate?.disconnect();
    this.panner.disconnect();
    this.fader.disconnect();
  }
}
