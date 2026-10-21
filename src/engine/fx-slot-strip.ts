/**
 * One effect slot of a mixer insert, wired like this:
 *
 *   in ─► bypass ───────────────────────────────────────────► out   (1 while not live)
 *    ├─► dryGate ─────────────────┐
 *    ├─► latency delay ─► align ──┴─► dryMix (1 − mix) ─────► out   (dryGate without latency, align with)
 *    └─► fx.input … fx.output ─► wetGate ─► wetMix (mix) ───► out
 *        (key ─► [pad] ─► host.sidechain, for effects that listen to a sidechain)
 *
 * The slot's mix is one ConstantSourceNode (offset = mix, written only by its AutoLane, the
 * `slot:…:mix` target) driving wetMix's gain directly and dryMix's through an inverter; the
 * gates (bypass, loading, missing, failed, instance swaps) are separate gains that glide. A slot
 * that isn't live is exactly its input (bypass 1, everything else 0).
 *
 * That mix stage (dryGate, dryMix, wetMix, the constant source: `FxMixStage`) exists only while it matters. A slot at
 * mix 1 that no automation drives wires the effect's wet gate straight to the output and has no dry path, which sounds
 * the same (the wet path passes at gain 1, the dry one at 0) and leaves out five nodes and an always-running
 * source per slot; the stage is made, in the same step, when the mix first moves off 1 or automation takes it over.
 *
 * Effects are created through HostImpl (owner { kind: 'fx', insertId, slotId }), asynchronously and
 * guarded by a generation token. While an effect loads, is missing, has failed or is disabled the
 * slot passes audio through (~10 ms crossfade), and a disabled effect's input (and key) is
 * disconnected after the fade to save CPU. Slots report their live latency (frames) and whether
 * they listen to a sidechain, for delay compensation.
 */
import { SLOT_MIX_SPEC } from '@core/model/target-specs';
import { targetKey } from '@core/model/targets';
import { automatedOwners, ownerKey } from '@core/automation/owners';
import type { FxSlot, InsertId, PluginOwner, PluginInstance, Project, SlotId } from '@core/model/types';
import type { AnyEffectDef, JsonValue, PluginDef } from '@agstudio/sdk';
import { clampOrFallback, glide } from './audio-graph';
import type { EngineCore } from './engine-core';
import { FxInstance } from './fx-instance';
import { FxMixStage } from './fx-mix-stage';
import { HostImpl } from './host';
import { AutoLane } from './param-lane';

/**
 * Time constant for enable/disable, mix changes and instance swaps: three of them make about a 10 ms crossfade
 * (long enough not to click, short enough to feel immediate).
 */
const SLOT_GLIDE_TAU_SEC = 0.01 / 3;
/** After this long a bypassed effect stops receiving input (the fade is long over). */
const UNFEED_DELAY_MS = 60;
/** A replaced instance keeps playing (fading out) this long before it is disposed. */
const RETIRE_DELAY_MS = 80;
/** The longest latency an effect may report (seconds); more is clamped. */
const MAX_EFFECT_LATENCY_SEC = 1;

/** One effect slot of an insert. */
export class FxSlotStrip {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly bypass: GainNode;
  /** The dry/wet blend; null while the slot is at mix 1 with nothing driving it (see the file comment). */
  private mixStage: FxMixStage | null = null;
  private readonly mixLane: AutoLane;
  private readonly unregisterMix: () => void;
  /** The current instance (null while loading, or when missing/failed). */
  private current: FxInstance | null = null;
  /** Replaced instances fading out. */
  private readonly retiring = new Set<FxInstance>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private unfeedTimer: ReturnType<typeof setTimeout> | null = null;
  /** The bypass path (input → bypass → output) is in the graph: always while not live, and until the fade is over after. */
  private isBypassWired = true;
  private bypassTimer: ReturnType<typeof setTimeout> | null = null;
  /** Counts loads: a load that finds a newer number when it finishes is stale and is thrown away. */
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private slot: FxSlot;
  private project: Project;
  private readonly owner: PluginOwner;
  /** The sidechain key: another track's sidechain tap, or null for the slot's own input. */
  private trackKey: AudioNode | null = null;
  private keyFrames = 0;
  private reportedFrames = 0;
  private reportedListens = false;
  /** Seconds after the song's clock the audio reaching this slot is (see setShift). */
  private shiftIn = 0;
  /** True when the plugin is missing or failed (the slot passes audio through; data is kept). */
  faulted = false;

  constructor(
    private readonly core: EngineCore,
    insertId: InsertId,
    slot: FxSlot,
    project: Project,
    /** Called when the slot's live latency or its listening to a sidechain changes. */
    private readonly onLatency: () => void = () => {},
  ) {
    const ctx = core.ctx;
    this.slot = slot;
    this.project = project;
    this.owner = { kind: 'fx', insertId, slotId: slot.id };
    this.input = new GainNode(ctx);
    this.output = new GainNode(ctx);
    this.bypass = new GainNode(ctx, { gain: 1 });
    this.mixLane = new AutoLane(
      ctx,
      targetKey({ kind: 'slot', insertId, slotId: slot.id, param: 'mix' }),
      SLOT_MIX_SPEC,
      clampOrFallback(slot.mix, 0, 1, 1),
      SLOT_GLIDE_TAU_SEC,
    );
    // Automation that starts to drive the mix needs the stage to write to.
    this.mixLane.onFirstDrive = () => this.ensureMixStage();
    this.unregisterMix = core.params.register(this.mixLane);
    this.input.connect(this.bypass).connect(this.output);
    if (clampOrFallback(slot.mix, 0, 1, 1) !== 1) this.ensureMixStage();
    this.load();
  }

  /** Where an effect's wet sound goes: through the mix stage's wet gain, or (at mix 1, nothing driving it) straight out. */
  private get wetDestination(): AudioNode {
    return this.mixStage?.wetMix ?? this.output;
  }

  /**
   * Makes the dry/wet stage when it is needed and moves the effects already here onto it: the wet gates go through its
   * wet gain and the latency-aligned dry paths join its dry gain. One step, so no sound is dropped or doubled.
   */
  private ensureMixStage(): void {
    if (this.mixStage) return;
    const stage = new FxMixStage(this.core.ctx, this.input, this.output, this.mixLane);
    this.mixStage = stage;
    for (const instance of this.instances()) instance.useMixStage(stage.wetMix, stage.dryMix);
    this.applyGains();
  }

  get id(): SlotId {
    return this.slot.id;
  }

  /** Resolves when the effect instance has been created (or has failed to be). */
  get ready(): Promise<void> {
    return this.pending;
  }

  get pluginId(): string {
    return this.slot.plugin.pluginId;
  }

  /** Seconds the effect keeps ringing after its input stops (0 when bypassed). */
  get tailTime(): number {
    const tail = this.live ? this.current?.effect.tailTime : 0;
    return typeof tail === 'number' && Number.isFinite(tail) ? Math.max(0, tail) : 0;
  }

  /** Frames the slot delays its audio by (its live effect's latency; 0 when it passes through). */
  get latencyFrames(): number {
    return this.live && this.current ? this.current.latencyFrames : 0;
  }

  /** The slot's live effect has a sidechain input. */
  get listens(): boolean {
    return this.live && !!this.current?.listens;
  }

  /** The track tap keying this slot's sidechain input (null: its own input). */
  get keySource(): AudioNode | null {
    return this.trackKey;
  }

  /**
   * The mixer's delay compensation holds the audio back: what reaches this slot is `inSeconds` behind the time the
   * song schedules it (and what leaves it `outSeconds`: its own latency later). The effect's params and transport
   * anchors follow `inSeconds`, the slot's mix `outSeconds` (the dry and wet paths meet at its output).
   */
  setShift(inSeconds: number, outSeconds: number): void {
    this.shiftIn = inSeconds;
    this.mixLane.shift = outSeconds;
    for (const instance of this.instances()) instance.host.setShift(inSeconds);
  }

  update(next: FxSlot, project: Project): void {
    const prev = this.slot;
    this.project = project;
    if (prev === next) return;
    this.slot = next;
    if (prev.plugin.pluginId !== next.plugin.pluginId) {
      this.load();
      return;
    }
    const ctx = this.core.ctx;
    if (prev.plugin !== next.plugin) this.current?.host.apply(next.plugin, project, ctx.currentTime);
    if (prev.mix !== next.mix) {
      const mix = clampOrFallback(next.mix, 0, 1, 1);
      if (mix !== 1) this.ensureMixStage();
      this.mixLane.setBase(mix, ctx.currentTime);
    }
    if (prev.enabled !== next.enabled) this.applyGains();
  }

  /**
   * What feeds the effect's sidechain input: another track's sidechain tap padded by `frames`, or
   * (null) the slot's own input. Only rewires; the effect is never recreated for it.
   */
  setKey(source: AudioNode | null, frames = 0): void {
    this.trackKey = source;
    this.keyFrames = source ? Math.max(0, Math.round(frames)) : 0;
    for (const instance of this.instances()) this.keyInstance(instance);
  }

  /** The project's sample table changed (effects with sample slots reload them). */
  samplesChanged(project: Project): void {
    this.project = project;
    this.current?.host.apply(this.slot.plugin, project, this.core.ctx.currentTime);
  }

  /**
   * Automation now drives this effect: an instance running as the lite processor (no AudioParams,
   * see HostDeps.lite) is replaced by a full one so automation can move its params.
   */
  automationChanged(project: Project): void {
    this.project = project;
    if (this.current?.host.lite && automatedOwners(project.channels).has(ownerKey(this.owner))) this.load();
  }

  /** Re-creates the effect (its code was hot-reloaded). */
  reload(project: Project): void {
    this.project = project;
    this.load();
  }

  dispose(): void {
    this.generation++;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.unfeedTimer) clearTimeout(this.unfeedTimer);
    this.unfeedTimer = null;
    if (this.bypassTimer) clearTimeout(this.bypassTimer);
    this.bypassTimer = null;
    for (const instance of this.retiring) instance.dispose(this.input);
    this.retiring.clear();
    this.current?.dispose(this.input);
    this.current = null;
    this.unregisterMix();
    this.mixLane.dispose();
    this.mixStage?.dispose(this.input);
    this.mixStage = null;
    for (const node of [this.input, this.bypass]) node.disconnect();
    this.output.disconnect();
  }

  /** The effect is loaded, enabled and has not failed: it is what is heard. */
  private get live(): boolean {
    return !!this.current && this.slot.enabled && !this.faulted;
  }

  private instances(): FxInstance[] {
    return this.current ? [this.current, ...this.retiring] : [...this.retiring];
  }

  private keyInstance(instance: FxInstance): void {
    instance.setKey(this.trackKey ?? this.input, this.keyFrames);
  }

  /** Gates for the current state, then (dis)connects the effect input; reports latency changes. */
  private applyGains(): void {
    const ctx = this.core.ctx;
    const live = this.live ? this.current : null;
    this.wireBypass(live === null);
    glide(this.bypass.gain, live ? 0 : 1, ctx, SLOT_GLIDE_TAU_SEC);
    if (this.mixStage) glide(this.mixStage.dryGate.gain, live && !live.dryDelay ? 1 : 0, ctx, SLOT_GLIDE_TAU_SEC);
    for (const instance of this.instances()) {
      const isHeard = instance === live;
      glide(instance.wetGate.gain, isHeard ? 1 : 0, ctx, SLOT_GLIDE_TAU_SEC);
      if (instance.dryAlign) glide(instance.dryAlign.gain, isHeard ? 1 : 0, ctx, SLOT_GLIDE_TAU_SEC);
    }
    if (this.unfeedTimer) {
      clearTimeout(this.unfeedTimer);
      this.unfeedTimer = null;
    }
    if (live) live.feed(this.input, true);
    else if (this.current) this.unfeedLater(this.current);
    this.reportLatencyChange();
  }

  /**
   * Puts the bypass path in the graph (at once, before it fades in) or takes it out once its fade-out is over (at once
   * before the context runs). A live effect leaves the bypass at gain 0, which adds nothing to the output, and a gain
   * node that stays in the graph costs the audio thread time on every block: a mixer has hundreds of slots.
   */
  private wireBypass(wanted: boolean): void {
    if (this.bypassTimer) clearTimeout(this.bypassTimer);
    this.bypassTimer = null;
    if (wanted) {
      if (this.isBypassWired) return;
      this.input.connect(this.bypass).connect(this.output);
      this.isBypassWired = true;
      return;
    }
    if (!this.isBypassWired) return;
    if (this.isBeforeStart) {
      this.unwireBypass();
      return;
    }
    this.bypassTimer = setTimeout(() => {
      this.bypassTimer = null;
      if (this.live) this.unwireBypass();
    }, UNFEED_DELAY_MS);
  }

  private unwireBypass(): void {
    this.input.disconnect(this.bypass);
    this.bypass.disconnect();
    this.isBypassWired = false;
  }

  /** Tells the insert when the slot's live latency or its listening to a sidechain changed. */
  private reportLatencyChange(): void {
    const frames = this.latencyFrames;
    const listens = this.listens;
    if (frames === this.reportedFrames && listens === this.reportedListens) return;
    this.reportedFrames = frames;
    this.reportedListens = listens;
    this.onLatency();
  }

  /** True before the context runs: offline renders and a context at time zero have no timers to wait for. */
  private get isBeforeStart(): boolean {
    return this.core.offline || this.core.ctx.currentTime === 0;
  }

  /** Stops feeding a bypassed effect once its fade-out is over (immediately offline). */
  private unfeedLater(instance: FxInstance): void {
    if (this.isBeforeStart) {
      instance.feed(this.input, false);
      return;
    }
    this.unfeedTimer = setTimeout(() => {
      this.unfeedTimer = null;
      if (this.current === instance && !this.live) instance.feed(this.input, false);
    }, UNFEED_DELAY_MS);
  }

  /** Fades an instance out and disposes it (immediately before the context runs). */
  private retire(instance: FxInstance): void {
    if (this.current === instance) this.current = null;
    if (this.isBeforeStart) {
      instance.dispose(this.input);
      return;
    }
    this.retiring.add(instance);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.retiring.delete(instance);
      instance.dispose(this.input);
    }, RETIRE_DELAY_MS);
    this.timers.add(timer);
  }

  /** Replaces the current effect by a new one made from the slot's plugin (asynchronously). */
  private load(): void {
    const generation = ++this.generation;
    if (this.current) this.retire(this.current);
    this.faulted = false;
    const data = this.slot.plugin;
    const def = this.core.plugins.get(data.pluginId);
    if (!def || def.kind !== 'effect') {
      this.failToLoad(def, data.pluginId);
      return;
    }
    // Pass audio through while the effect loads.
    this.applyGains();
    const host = this.createHost(def, data, generation);
    host.setShift(this.shiftIn);
    this.pending = this.instantiate(def, host, generation);
  }

  /** The plugin is missing or is not an effect: the slot passes audio through and reports it. */
  private failToLoad(def: PluginDef | undefined, pluginId: string): void {
    this.faulted = true;
    this.pending = Promise.resolve();
    this.applyGains();
    const reason = def ? new Error(`"${def.name}" is an instrument and can't go in an effect slot`) : 'missing';
    this.core.reportFault(this.owner, pluginId, reason);
  }

  private createHost(def: AnyEffectDef, data: PluginInstance, generation: number): HostImpl {
    return new HostImpl({
      ctx: this.core.ctx,
      def,
      data,
      project: this.project,
      samples: this.core.samples,
      transport: this.core.transportInfo,
      rootKey: null,
      offline: this.core.offline,
      registry: this.core.params,
      requestState: (state: JsonValue) => this.core.requestState(this.owner, state),
      owner: this.owner,
      loadModule: (url) => this.core.loadModule(url),
      ports: this.core.ports,
      noteFeed: this.core.noteFeed,
      reportFault: (err) => {
        if (generation === this.generation) this.fault(err);
      },
      reportTap: (tap, live) => this.core.reportTap?.(this.owner, tap, live),
      lite: () => !automatedOwners(this.project.channels).has(ownerKey(this.owner)),
    });
  }

  /** Creates the effect, and makes it the slot's current instance unless a newer load has started meanwhile. */
  private async instantiate(def: AnyEffectDef, host: HostImpl, generation: number): Promise<void> {
    const ctx = this.core.ctx;
    try {
      const effect = await def.create(host);
      if (generation !== this.generation) {
        effect.dispose();
        host.dispose();
        return;
      }
      host.onState = (state) => effect.setState?.(state as never);
      const latencySec = typeof effect.latency === 'number' ? clampOrFallback(effect.latency, 0, MAX_EFFECT_LATENCY_SEC, 0) : 0;
      const latencyFrames = Math.round(latencySec * ctx.sampleRate);
      this.current = new FxInstance(ctx, effect, host, this.wetDestination, this.mixStage?.dryMix ?? null, latencyFrames);
      this.keyInstance(this.current);
      this.faulted = false;
      // Catch up with edits made while the effect was loading.
      host.apply(this.slot.plugin, this.project, ctx.currentTime);
      this.applyGains();
    } catch (err) {
      host.dispose();
      if (generation === this.generation) this.fault(err);
    }
  }

  private fault(err: unknown): void {
    this.faulted = true;
    this.applyGains();
    this.core.reportFault(this.owner, this.slot.plugin.pluginId, err);
  }
}
