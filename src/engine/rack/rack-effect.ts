/**
 * The effect inside an effect-rack slot (see `docs/architecture.md`, "Effect racks"):
 *
 *   input ─► split ─► branch 1 … branch N ─► sum (OrderedMix) ─► output gain ─► output
 *
 * Its pieces: `rack-split.ts` (how the input is shared out and put together again), `rack-branch.ts` (a chain of effects
 * with a level, a pan and a gate), `macro-links.ts` (the macro knobs).
 *
 * - **Latency.** Every effect inside reports its latency like any effect. A branch's latency is the sum of its live effects;
 *   the rack's is the slowest branch's, and every quicker branch (the dry branch, an empty one) gets an alignment delay of
 *   the difference, so the branches add up in time. The rack reports the total to its slot, which delays its own dry path
 *   by it and tells the mixer's delay compensation. Muting or soloing a branch never changes the latency.
 * - **Sleeping.** A branch that does not sound is cut off at both ends, so nothing in it is processed; what an insert needs
 *   before it may park is asked of the branches that sound only.
 * - **Rendering.** The branches join through an `OrderedMix`, so an offline render sums them in the same order every time.
 */
import { macroParamId, makeRack } from '@core/model/rack';
import { audibleBranches } from '@core/query/rack';
import { CROSSOVER_SPEC } from '@core/rack/mapping';
import type { BranchId, FxSlot, MacroTarget, PluginOwner, Project, Rack, RackBranch, SlotId } from '@core/model/types';
import { OrderedMix, dbToGain, type EffectInstance } from '@agstudio/sdk';
import { clampOrFallback } from '../audio-graph';
import type { FxSlotStrip, SlotHooks, SlotIdleNeeds } from '../fx-slot-strip';
import type { HostImpl } from '../host';
import { AutoLane } from '../param-lane';
import { MacroLinks } from './macro-links';
import { Branch } from './rack-branch';
import type { NestedEffect, RackBuild } from './rack-build';
import { makeSplitNetwork, type SplitNetwork } from './rack-split';

/** Time constant of a crossover frequency move (seconds). */
const CROSSOVER_GLIDE_TAU_SEC = 0.01 / 3;

/** The effect a rack slot holds. */
export class RackEffect implements EffectInstance, NestedEffect {
  readonly isNested = true as const;
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly sum: OrderedMix;
  private readonly unbindGain: () => void;
  private network: SplitNetwork | null = null;
  private networkSignature = '';
  private crossoverLanes: AutoLane[] = [];
  private readonly branches = new Map<BranchId, Branch>();
  private order: Branch[] = [];
  private rack: Rack;
  private project: Project;
  /** The host of each effect inside, while it exists (the macros reach its params through it). */
  private readonly hosts = new Map<SlotId, HostImpl>();
  private readonly links: MacroLinks;
  private frames = 0;
  private shiftInSec = 0;
  private isParked = false;
  private isDisposed = false;
  private readonly hooks: SlotHooks;
  private readonly owner: PluginOwner;

  constructor(
    private readonly host: HostImpl,
    private readonly build: RackBuild,
  ) {
    const ctx = build.core.ctx;
    this.owner = build.owner;
    this.rack = build.slot().rack ?? makeRack();
    this.project = build.project();
    this.input = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.output = new GainNode(ctx);
    this.sum = new OrderedMix(ctx, this.output);
    const gain = host.params.gain;
    this.unbindGain = gain ? gain.bind(this.output.gain, dbToGain) : () => {};
    this.hooks = {
      hostCreated: (slotId, slotHost) => {
        this.hosts.set(slotId, slotHost);
        this.links.sync(this.rack.macros);
      },
    };
    this.links = new MacroLinks(
      (index) => host.params[macroParamId(index)]?.lane ?? null,
      (target) => this.laneOf(target),
    );
    this.reconcile(this.rack, this.project);
  }

  // ── What the slot reads ──────────────────────────────────────────────────────────────────────

  /** Seconds the rack's audio is behind its input. */
  get latency(): number {
    return this.frames / this.build.core.ctx.sampleRate;
  }

  get latencyFrames(): number {
    return this.frames;
  }

  /** Seconds the audible branches' effects ring after their input stops (the longest branch). */
  get tailTime(): number {
    let tail = 0;
    for (const branch of this.order) if (branch.audible) tail = Math.max(tail, branch.tailTime);
    return tail;
  }

  get ready(): Promise<void> {
    return Promise.all(this.order.map((branch) => branch.chain.ready)).then(() => undefined);
  }

  idleNeeds(): SlotIdleNeeds {
    let busy = false;
    let tailSec = 0;
    for (const branch of this.order) {
      const needs = branch.idleNeeds();
      busy = busy || needs.busy;
      tailSec = Math.max(tailSec, needs.tailSec);
    }
    return { busy, tailSec };
  }

  /** The effect strips inside, branch by branch (tests and diagnostics). */
  get slotStrips(): readonly FxSlotStrip[] {
    return this.order.flatMap((branch) => [...branch.chain.slotStrips]);
  }

  /** How many macro targets are hooked now (tests and diagnostics). */
  get linkedTargets(): number {
    return this.links.size;
  }

  // ── What the slot tells it ───────────────────────────────────────────────────────────────────

  applyRack(slot: FxSlot, project: Project): void {
    this.project = project;
    if (!slot.rack || slot.rack === this.rack) return;
    this.reconcile(slot.rack, project);
  }

  setShift(inSeconds: number, outSeconds: number): void {
    this.shiftInSec = inSeconds;
    this.applyShift();
    const gain = this.host.params.gain;
    if (gain) gain.lane.shift = outSeconds;
  }

  setParked(isParked: boolean): void {
    this.isParked = isParked;
    for (const branch of this.order) branch.setParked(isParked);
  }

  samplesChanged(project: Project): void {
    this.project = project;
    for (const branch of this.order) branch.chain.samplesChanged(project);
  }

  automationChanged(project: Project): void {
    this.project = project;
    for (const branch of this.order) branch.chain.automationChanged(project);
  }

  pluginsChanged(ids: ReadonlySet<string>, project: Project): void {
    this.project = project;
    for (const branch of this.order) branch.chain.pluginsChanged(ids, project);
  }

  dispose(): void {
    this.isDisposed = true;
    this.links.dispose();
    for (const branch of this.order) branch.dispose();
    this.order = [];
    this.branches.clear();
    this.network?.dispose();
    this.network = null;
    for (const lane of this.crossoverLanes) lane.dispose();
    this.crossoverLanes = [];
    this.unbindGain();
    this.sum.dispose();
    this.input.disconnect();
    this.output.disconnect();
  }

  // ── Keeping up with the document ─────────────────────────────────────────────────────────────

  /** Brings the branches, the split, the crossovers, the macros and the alignment in line with the rack. */
  private reconcile(rack: Rack, project: Project): void {
    this.rack = rack;
    this.project = project;
    const now = this.build.core.ctx.currentTime;
    this.syncBranches(rack, project);
    const signature = `${rack.split}|${rack.branches.map((branch) => branch.id).join(',')}|${rack.crossovers.length}`;
    if (signature !== this.networkSignature) this.rebuildNetwork(rack, signature);
    rack.crossovers.forEach((hz, index) => this.crossoverLanes[index]?.setBase(clampOrFallback(hz, CROSSOVER_SPEC.min, CROSSOVER_SPEC.max, CROSSOVER_SPEC.default), now));
    this.connectBranches(rack);
    this.links.sync(rack.macros);
    this.alignBranches();
  }

  /** Branches are kept by id: new ones are made, removed ones disposed, the rest updated. */
  private syncBranches(rack: Rack, project: Project): void {
    const wanted = new Set(rack.branches.map((branch) => branch.id));
    for (const [id, branch] of this.branches) {
      if (wanted.has(id)) continue;
      branch.dispose();
      this.branches.delete(id);
    }
    for (const data of rack.branches) {
      const existing = this.branches.get(data.id);
      if (existing) existing.update(data, project);
      else this.branches.set(data.id, this.makeBranch(data, project));
    }
    this.order = rack.branches.map((data) => this.branches.get(data.id) as Branch);
    for (const branch of this.order) branch.setParked(this.isParked);
  }

  private makeBranch(data: RackBranch, project: Project): Branch {
    const slot = this.build.slot();
    return new Branch({
      core: this.build.core,
      insertId: this.build.insertId,
      parentOwner: this.owner,
      keyPrefix: `${this.build.insertId}:${slot.id}`,
      data,
      project,
      hooks: this.hooks,
      onLatency: () => {
        if (!this.isDisposed) this.alignBranches();
      },
    });
  }

  /** Makes the split's wiring for the rack's mode, branch order and crossovers (the effects keep running). */
  private rebuildNetwork(rack: Rack, signature: string): void {
    const ctx = this.build.core.ctx;
    for (const branch of this.order) branch.disconnect();
    this.network?.dispose();
    for (const lane of this.crossoverLanes) lane.dispose();
    this.crossoverLanes = rack.crossovers.map(
      (hz, index) =>
        new AutoLane(
          ctx,
          `rack:${this.build.insertId}:${this.build.slot().id}:crossover${index}`,
          CROSSOVER_SPEC,
          clampOrFallback(hz, CROSSOVER_SPEC.min, CROSSOVER_SPEC.max, CROSSOVER_SPEC.default),
          CROSSOVER_GLIDE_TAU_SEC,
        ),
    );
    this.network = makeSplitNetwork(rack.split, {
      ctx,
      input: this.input,
      sum: this.sum,
      branches: this.order.length,
      crossoverLanes: this.crossoverLanes,
    });
    this.networkSignature = signature;
    this.applyShift();
  }

  /** Feeds each branch that sounds, and cuts off the ones that do not. */
  private connectBranches(rack: Rack): void {
    const network = this.network;
    if (!network) return;
    const audible = audibleBranches(rack);
    this.order.forEach((branch, index) => {
      branch.connect(network.feed(index), (output) => network.join(index, output), audible.has(branch.id));
    });
  }

  /**
   * The rack's latency is the slowest branch's; each quicker branch is delayed by the difference. When the total changes
   * the slot is told, and the shifts of everything inside move with it.
   */
  private alignBranches(): void {
    const latencies = this.order.map((branch) => branch.latencyFrames);
    const total = latencies.reduce((most, frames) => Math.max(most, frames), 0);
    this.order.forEach((branch, index) => branch.setAlignment(total - (latencies[index] as number)));
    const changed = total !== this.frames;
    this.frames = total;
    this.applyShift();
    if (changed) this.build.onLatency();
  }

  /** The chains' params, the branches' levels and pans and the crossovers follow where the delay compensation puts the rack. */
  private applyShift(): void {
    const sampleRate = this.build.core.ctx.sampleRate;
    const inFrames = this.shiftInSec * sampleRate;
    for (const branch of this.order) branch.setAlignedShift(inFrames, inFrames + this.frames);
    for (const lane of this.crossoverLanes) lane.shift = this.shiftInSec;
  }

  /** The lane a macro drives for this target, or null while its effect, branch or crossover is not there. */
  private laneOf(target: MacroTarget): AutoLane | null {
    switch (target.kind) {
      case 'param': {
        const host = this.hosts.get(target.slotId);
        if (!host || host.signal.aborted) return null;
        return host.params[target.paramId]?.lane ?? null;
      }
      case 'mix':
        return this.slotStrips.find((strip) => strip.id === target.slotId)?.mix ?? null;
      case 'branch': {
        const branch = this.branches.get(target.branchId);
        if (!branch) return null;
        return target.param === 'level' ? branch.levelLane : branch.panLane;
      }
      case 'crossover':
        return this.crossoverLanes[target.index] ?? null;
      case 'gain':
        return this.host.params.gain?.lane ?? null;
    }
  }
}
