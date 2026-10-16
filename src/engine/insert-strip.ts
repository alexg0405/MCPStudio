/**
 * Mixer inserts and their effect slots. The insert's persistent nodes (its taps, see
 * engine/mixer-graph.ts) belong to the mixer graph; a strip wires its own nodes between them:
 *
 *   routeIn → slot 1 … slot N → scTap → gate (mute/solo) → preTap → StereoPanner → fader → postTap
 *                                                                        (meters: ChannelSplitter → 2× AnalyserNode, only while read)
 *   slot: in ─► bypass ───────────────────────────────────────────► out   (1 while not live)
 *          ├─► dryGate ─────────────────┐
 *          ├─► latency delay ─► align ──┴─► dryMix (1 − mix) ─────► out   (dryGate without latency, align with)
 *          └─► fx.input … fx.output ─► wetGate ─► wetMix (mix) ───► out
 *              (key ─► [pad] ─► host.sidechain, for effects that listen to a sidechain)
 *
 * The slot's mix is one ConstantSourceNode (offset = mix, written only by its AutoLane, the
 * `slot:…:mix` target) driving wetMix's gain directly and dryMix's through an inverter; the
 * gates (bypass, loading, missing, failed, instance swaps) are separate gains that glide. A slot
 * that isn't live is exactly its input (bypass 1, everything else 0).
 *
 * Effects are created through HostImpl (owner { kind: 'fx', insertId, slotId }), asynchronously and
 * guarded by a generation token. While an effect loads, is missing, has failed or is disabled the
 * slot passes audio through (~10 ms crossfade), and a disabled effect's input (and key) is
 * disconnected after the fade to save CPU. Reordering slots only rewires them. Slots report their
 * live latency (frames) and whether they listen to a sidechain, for delay compensation.
 */
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { INSERT_PAN_SPEC, INSERT_VOLUME_SPEC, SLOT_MIX_SPEC } from '@core/model/target-specs';
import { targetKey } from '@core/model/targets';
import { automatedOwners, ownerKey } from '@core/automation/owners';
import type { FxSlot, Insert, InsertId, PluginOwner, Project, SlotId } from '@core/model/types';
import type { EffectInstance, JsonValue } from '@agstudio/sdk';
import type { EngineCore } from './engine-core';
import { HostImpl } from './host';
import { AutoLane } from './param-lane';

/** Time constant for enable/disable, mix changes and instance swaps (≈ 10 ms crossfade). */
const SLOT_TAU = 0.01 / 3;
/** Time constant for fader/pan/mute moves (matches channel strips). */
const STRIP_TAU = 0.004;
/** After this long a bypassed effect stops receiving input (the fade is long over). */
const UNFEED_MS = 60;
/** A replaced instance keeps playing (fading out) this long before it is disposed. */
const RETIRE_MS = 80;
/** Latency an effect may report (seconds); more is clamped. */
const MAX_LATENCY = 1;
/** Analyser size for meters (≈ 43 ms at 48 kHz). */
export const METER_FRAMES = 2048;
/** Meters are taken out of the graph once nobody has read them for this long (ms): a closed mixer costs nothing. */
const METER_IDLE_MS = 2500;

const clamp = (v: number, lo: number, hi: number, fallback = lo) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/**
 * Moves an AudioParam to `value`: smoothed while the context runs, immediately before it has
 * started (offline renders apply the whole document at time 0, so they are exact and timer-free).
 */
export function glide(param: AudioParam, value: number, ctx: BaseAudioContext, timeConstant: number): void {
  if (ctx.currentTime === 0) {
    param.cancelScheduledValues(0);
    param.setValueAtTime(value, 0);
  } else {
    param.setTargetAtTime(value, ctx.currentTime, timeConstant);
  }
}

export function disconnectFrom(from: AudioNode, to: AudioNode | AudioParam): void {
  try {
    from.disconnect(to as AudioNode);
  } catch {
    /* not connected */
  }
}

/** A DelayNode of exactly `frames` frames (Chrome delays by exactly n frames at n / sampleRate). */
export function frameDelay(ctx: BaseAudioContext, frames: number): DelayNode {
  const seconds = frames / ctx.sampleRate;
  return new DelayNode(ctx, { maxDelayTime: seconds + 0.01, delayTime: seconds });
}

/** One live effect instance: its wet gate, latency-aligned dry path and sidechain key. */
class Instance {
  readonly wetGate: GainNode;
  readonly delay: DelayNode | null = null;
  readonly align: GainNode | null = null;
  private fed = false;
  private keySource: AudioNode | null = null;
  private keyFrames = 0;
  /** The key path while connected: source → [keyDelay] → host.sidechain. */
  private keyOn = false;
  private keyDelay: DelayNode | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly inst: EffectInstance,
    readonly host: HostImpl,
    wetMix: AudioNode,
    dryMix: AudioNode,
    /** Latency in frames. */
    readonly frames: number,
  ) {
    this.wetGate = new GainNode(ctx, { gain: 0 });
    inst.output.connect(this.wetGate);
    this.wetGate.connect(wetMix);
    if (frames > 0) {
      this.delay = frameDelay(ctx, frames);
      this.align = new GainNode(ctx, { gain: 0 });
      this.delay.connect(this.align);
      this.align.connect(dryMix);
    }
  }

  /** The effect has a sidechain input. */
  get listens(): boolean {
    return this.host.sidechain !== null;
  }

  /** Connects or disconnects the slot input to the effect (its aligned dry path and its key too). */
  feed(input: AudioNode, on: boolean): void {
    if (on === this.fed) return;
    this.fed = on;
    if (on) {
      input.connect(this.inst.input);
      if (this.delay) input.connect(this.delay);
    } else {
      disconnectFrom(input, this.inst.input);
      if (this.delay) disconnectFrom(input, this.delay);
    }
    this.syncKey();
  }

  /** What feeds the effect's sidechain input, padded by `frames` (delay compensation). */
  setKey(source: AudioNode, frames: number): void {
    if (source === this.keySource && frames === this.keyFrames) return;
    this.unkey();
    this.keySource = source;
    this.keyFrames = frames;
    this.syncKey();
  }

  dispose(input: AudioNode): void {
    this.feed(input, false);
    this.unkey();
    disconnectFrom(this.inst.output, this.wetGate);
    this.wetGate.disconnect();
    this.delay?.disconnect();
    this.align?.disconnect();
    try {
      this.inst.dispose();
    } catch (err) {
      console.error('effect dispose failed', err);
    }
    this.host.dispose();
  }

  private syncKey(): void {
    const sidechain = this.host.sidechain;
    const want = this.fed && sidechain !== null && this.keySource !== null;
    if (want === this.keyOn) return;
    if (!want) {
      this.unkey();
      return;
    }
    const source = this.keySource as AudioNode;
    const target = sidechain as AudioNode;
    if (this.keyFrames > 0) {
      this.keyDelay = frameDelay(this.ctx, this.keyFrames);
      source.connect(this.keyDelay).connect(target);
    } else source.connect(target);
    this.keyOn = true;
  }

  private unkey(): void {
    if (!this.keyOn) return;
    this.keyOn = false;
    const source = this.keySource as AudioNode;
    const target = this.host.sidechain as AudioNode;
    if (this.keyDelay) {
      disconnectFrom(source, this.keyDelay);
      this.keyDelay.disconnect();
      this.keyDelay = null;
    } else disconnectFrom(source, target);
  }
}

/** One effect slot of an insert. */
export class FxSlotStrip {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly bypass: GainNode;
  private readonly dryGate: GainNode;
  private readonly dryMix: GainNode;
  private readonly wetMix: GainNode;
  private readonly mixSource: ConstantSourceNode;
  private readonly mixInvert: GainNode;
  private readonly mixLane: AutoLane;
  private readonly unregisterMix: () => void;
  /** The current instance (null while loading, or when missing/failed). */
  private current: Instance | null = null;
  /** Replaced instances fading out. */
  private readonly retiring = new Set<Instance>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private unfeedTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.dryGate = new GainNode(ctx, { gain: 0 });
    this.dryMix = new GainNode(ctx, { gain: 1 });
    this.wetMix = new GainNode(ctx, { gain: 0 });
    this.mixSource = new ConstantSourceNode(ctx, { offset: 0 });
    this.mixInvert = new GainNode(ctx, { gain: -1 });
    this.mixSource.connect(this.wetMix.gain);
    this.mixSource.connect(this.mixInvert).connect(this.dryMix.gain);
    this.mixLane = new AutoLane(
      ctx,
      targetKey({ kind: 'slot', insertId, slotId: slot.id, param: 'mix' }),
      SLOT_MIX_SPEC,
      clamp(slot.mix, 0, 1, 1),
      SLOT_TAU,
    );
    this.mixLane.bind(this.mixSource.offset);
    this.unregisterMix = core.params.register(this.mixLane);
    this.mixSource.start();
    this.input.connect(this.bypass).connect(this.output);
    this.input.connect(this.dryGate).connect(this.dryMix);
    this.dryMix.connect(this.output);
    this.wetMix.connect(this.output);
    this.load();
  }

  get id(): SlotId {
    return this.slot.id;
  }

  get ready(): Promise<void> {
    return this.pending;
  }

  get pluginId(): string {
    return this.slot.plugin.pluginId;
  }

  /** Seconds the effect keeps ringing after its input stops (0 when bypassed). */
  get tailTime(): number {
    const t = this.live ? this.current?.inst.tailTime : 0;
    return typeof t === 'number' && Number.isFinite(t) ? Math.max(0, t) : 0;
  }

  /** Frames the slot delays its audio by (its live effect's latency; 0 when it passes through). */
  get latencyFrames(): number {
    return this.live && this.current ? this.current.frames : 0;
  }

  /** The slot's live effect has a sidechain input. */
  get listens(): boolean {
    return this.live && !!this.current?.listens;
  }

  /** The track tap keying this slot's sidechain input (null: its own input). */
  get keySource(): AudioNode | null {
    return this.trackKey;
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
    if (prev.mix !== next.mix) this.mixLane.setBase(clamp(next.mix, 0, 1, 1), ctx.currentTime);
    if (prev.enabled !== next.enabled) this.applyGains();
  }

  /**
   * What feeds the effect's sidechain input: another track's sidechain tap padded by `frames`, or
   * (null) the slot's own input. Only rewires; the effect is never recreated for it.
   */
  setKey(source: AudioNode | null, frames = 0): void {
    this.trackKey = source;
    this.keyFrames = source ? Math.max(0, Math.round(frames)) : 0;
    for (const inst of this.instances()) this.keyInstance(inst);
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
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.unfeedTimer) clearTimeout(this.unfeedTimer);
    this.unfeedTimer = null;
    for (const inst of this.retiring) inst.dispose(this.input);
    this.retiring.clear();
    this.current?.dispose(this.input);
    this.current = null;
    this.unregisterMix();
    this.mixLane.dispose();
    try {
      this.mixSource.stop();
    } catch {
      /* not started */
    }
    for (const n of [this.mixSource, this.mixInvert, this.input, this.bypass, this.dryGate, this.dryMix, this.wetMix])
      n.disconnect();
    this.output.disconnect();
  }

  private get live(): boolean {
    return !!this.current && this.slot.enabled && !this.faulted;
  }

  private instances(): Instance[] {
    return this.current ? [this.current, ...this.retiring] : [...this.retiring];
  }

  private keyInstance(inst: Instance): void {
    inst.setKey(this.trackKey ?? this.input, this.keyFrames);
  }

  /** Gates for the current state, then (dis)connects the effect input; reports latency changes. */
  private applyGains(): void {
    const ctx = this.core.ctx;
    const live = this.live ? this.current : null;
    glide(this.bypass.gain, live ? 0 : 1, ctx, SLOT_TAU);
    glide(this.dryGate.gain, live && !live.delay ? 1 : 0, ctx, SLOT_TAU);
    for (const inst of this.instances()) {
      const on = inst === live;
      glide(inst.wetGate.gain, on ? 1 : 0, ctx, SLOT_TAU);
      if (inst.align) glide(inst.align.gain, on ? 1 : 0, ctx, SLOT_TAU);
    }
    if (this.unfeedTimer) {
      clearTimeout(this.unfeedTimer);
      this.unfeedTimer = null;
    }
    if (live) live.feed(this.input, true);
    else if (this.current) this.unfeedLater(this.current);
    this.report();
  }

  private report(): void {
    const frames = this.latencyFrames;
    const listens = this.listens;
    if (frames === this.reportedFrames && listens === this.reportedListens) return;
    this.reportedFrames = frames;
    this.reportedListens = listens;
    this.onLatency();
  }

  /** Stops feeding a bypassed effect once its fade-out is over (immediately offline). */
  private unfeedLater(inst: Instance): void {
    if (this.core.offline || this.core.ctx.currentTime === 0) {
      inst.feed(this.input, false);
      return;
    }
    this.unfeedTimer = setTimeout(() => {
      this.unfeedTimer = null;
      if (this.current === inst && !this.live) inst.feed(this.input, false);
    }, UNFEED_MS);
  }

  /** Fades an instance out and disposes it (immediately before the context runs). */
  private retire(inst: Instance): void {
    if (this.current === inst) this.current = null;
    if (this.core.offline || this.core.ctx.currentTime === 0) {
      inst.dispose(this.input);
      return;
    }
    this.retiring.add(inst);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.retiring.delete(inst);
      inst.dispose(this.input);
    }, RETIRE_MS);
    this.timers.add(timer);
  }

  private load(): void {
    const gen = ++this.generation;
    if (this.current) this.retire(this.current);
    this.faulted = false;
    const data = this.slot.plugin;
    const def = this.core.plugins.get(data.pluginId);
    if (!def || def.kind !== 'effect') {
      this.faulted = true;
      this.pending = Promise.resolve();
      this.applyGains();
      this.core.reportFault(
        this.owner,
        data.pluginId,
        def ? new Error(`"${def.name}" is an instrument and can't go in an effect slot`) : 'missing',
      );
      return;
    }
    // Pass audio through while the effect loads.
    this.applyGains();
    const ctx = this.core.ctx;
    const host = new HostImpl({
      ctx,
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
      reportFault: (err) => {
        if (gen === this.generation) this.fault(err);
      },
      reportTap: (tap, live) => this.core.reportTap?.(this.owner, tap, live),
      lite: () => !automatedOwners(this.project.channels).has(ownerKey(this.owner)),
    });
    this.pending = (async () => {
      try {
        const inst = await def.create(host);
        if (gen !== this.generation) {
          inst.dispose();
          host.dispose();
          return;
        }
        host.onState = (s) => inst.setState?.(s as never);
        const latency = typeof inst.latency === 'number' ? clamp(inst.latency, 0, MAX_LATENCY, 0) : 0;
        const frames = Math.round(latency * ctx.sampleRate);
        this.current = new Instance(ctx, inst, host, this.wetMix, this.dryMix, frames);
        this.keyInstance(this.current);
        this.faulted = false;
        // Catch up with edits made while the effect was loading.
        host.apply(this.slot.plugin, this.project, ctx.currentTime);
        this.applyGains();
      } catch (err) {
        host.dispose();
        if (gen === this.generation) this.fault(err);
      }
    })();
  }

  private fault(err: unknown): void {
    this.faulted = true;
    this.applyGains();
    this.core.reportFault(this.owner, this.slot.plugin.pluginId, err);
  }
}

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
  private readonly gate: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly fader: GainNode;
  /** Made on the first read and dropped again after METER_IDLE_MS without one (see readPeaks). */
  private splitter: ChannelSplitterNode | null = null;
  private meters: readonly AnalyserNode[] = [];
  private lastMeterRead = 0;
  private meterTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly slots = new Map<SlotId, FxSlotStrip>();
  private chain: readonly SlotId[] = [];
  private ordered: readonly FxSlotStrip[] = [];
  private insert: Insert;
  private muted = false;
  private readonly volLane: AutoLane;
  private readonly panLane: AutoLane;
  private readonly unregister: (() => void)[];

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
    this.gate = new GainNode(ctx);
    this.panner = new StereoPannerNode(ctx);
    this.fader = new GainNode(ctx);
    const key = (param: 'volume' | 'pan') => targetKey({ kind: 'insert', insertId: insert.id, param });
    this.volLane = new AutoLane(
      ctx,
      key('volume'),
      INSERT_VOLUME_SPEC,
      clamp(insert.volume, 0, MAX_INSERT_VOLUME),
      STRIP_TAU,
    );
    this.panLane = new AutoLane(ctx, key('pan'), INSERT_PAN_SPEC, clamp(insert.pan, -1, 1, 0), STRIP_TAU);
    this.volLane.bind(this.fader.gain);
    this.panLane.bind(this.panner.pan);
    this.unregister = [core.params.register(this.volLane), core.params.register(this.panLane)];
    taps.scTap.connect(this.gate);
    this.gate.connect(taps.preTap);
    taps.preTap.connect(this.panner);
    this.panner.connect(this.fader);
    this.fader.connect(taps.postTap);
    this.wire([]);
    if (project) this.syncSlots(insert.fx, project);
  }

  get id(): InsertId {
    return this.insert.id;
  }

  get ready(): Promise<void> {
    return Promise.all([...this.slots.values()].map((s) => s.ready)).then(() => undefined);
  }

  /** Seconds of tail added by this insert's effects (they run in series). */
  get tailTime(): number {
    let t = 0;
    for (const s of this.slots.values()) t += s.tailTime;
    return t;
  }

  /** The effect slots in chain order. */
  get slotStrips(): readonly FxSlotStrip[] {
    return this.ordered;
  }

  update(next: Insert, project: Project): void {
    const prev = this.insert;
    if (prev === next) return;
    this.insert = next;
    const ctx = this.core.ctx;
    if (prev.volume !== next.volume) this.volLane.setBase(clamp(next.volume, 0, MAX_INSERT_VOLUME), ctx.currentTime);
    if (prev.pan !== next.pan) this.panLane.setBase(clamp(next.pan, -1, 1, 0), ctx.currentTime);
    if (prev.fx !== next.fx) this.syncSlots(next.fx, project);
  }

  samplesChanged(project: Project): void {
    for (const s of this.slots.values()) s.samplesChanged(project);
  }

  /** The set of automated plugin instances changed (see FxSlotStrip.automationChanged). */
  automationChanged(project: Project): void {
    for (const s of this.slots.values()) s.automationChanged(project);
  }

  /** Rebuilds effects whose plugin definition changed (hot reload, install/uninstall). */
  pluginsChanged(ids: ReadonlySet<string>, project: Project): void {
    for (const s of this.slots.values()) if (ids.has(s.pluginId)) s.reload(project);
  }

  /** The mute/solo gate (after the effects, so pre-fader sends are muted too; the sidechain tap isn't). */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    glide(this.gate.gain, muted ? 0 : 1, this.core.ctx, STRIP_TAU);
  }

  /**
   * Writes the left/right peak of the last METER_FRAMES frames into out[at], out[at + 1]. The meter
   * analysers only exist while someone reads them (the mixer's meters, every frame): the first read
   * connects them and reads 0, and they go away again after METER_IDLE_MS. Offline renders have none.
   */
  readPeaks(scratch: Float32Array<ArrayBuffer>, out: Float32Array, at: number): void {
    if (!this.core.offline) this.touchMeters();
    for (let c = 0; c < 2; c++) {
      const meter = this.meters[c];
      let peak = 0;
      if (meter) {
        meter.getFloatTimeDomainData(scratch);
        for (let i = 0; i < scratch.length; i++) {
          const v = scratch[i] as number;
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
        }
      }
      if (at + c < out.length) out[at + c] = peak;
    }
  }

  /** True while the meter analysers are in the graph (diagnostics and tests). */
  get metering(): boolean {
    return this.splitter !== null;
  }

  private touchMeters(): void {
    this.lastMeterRead = performance.now();
    if (this.splitter) return;
    const ctx = this.core.ctx;
    const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    const meters = [0, 1].map(() => new AnalyserNode(ctx, { fftSize: METER_FRAMES, smoothingTimeConstant: 0 }));
    this.taps.postTap.connect(splitter);
    meters.forEach((m, i) => splitter.connect(m, i));
    this.splitter = splitter;
    this.meters = meters;
    this.meterTimer = setTimeout(() => this.checkMeters(), METER_IDLE_MS);
  }

  private checkMeters(): void {
    this.meterTimer = null;
    const idle = performance.now() - this.lastMeterRead;
    if (idle < METER_IDLE_MS) this.meterTimer = setTimeout(() => this.checkMeters(), METER_IDLE_MS - idle);
    else this.dropMeters();
  }

  private dropMeters(): void {
    if (this.meterTimer !== null) clearTimeout(this.meterTimer);
    this.meterTimer = null;
    if (this.splitter) disconnectFrom(this.taps.postTap, this.splitter);
    this.splitter?.disconnect();
    for (const m of this.meters) m.disconnect();
    this.splitter = null;
    this.meters = [];
  }

  dispose(): void {
    for (const s of this.slots.values()) s.dispose();
    this.slots.clear();
    this.ordered = [];
    for (const off of this.unregister) off();
    this.volLane.dispose();
    this.panLane.dispose();
    // Only the strip's own connections: the taps' sends belong to the mixer graph.
    this.taps.routeIn.disconnect();
    disconnectFrom(this.taps.scTap, this.gate);
    disconnectFrom(this.taps.preTap, this.panner);
    this.dropMeters();
    this.gate.disconnect();
    this.panner.disconnect();
    this.fader.disconnect();
  }

  /** Keyed by SlotId: new slots are created, removed ones disposed, moved ones only rewired. */
  private syncSlots(fx: readonly FxSlot[], project: Project): void {
    const next: FxSlotStrip[] = [];
    const ids: SlotId[] = [];
    for (const data of fx) {
      if (ids.includes(data.id)) continue;
      let strip = this.slots.get(data.id);
      if (strip) strip.update(data, project);
      else {
        strip = new FxSlotStrip(this.core, this.insert.id, data, project, this.onLatency);
        this.slots.set(data.id, strip);
      }
      next.push(strip);
      ids.push(data.id);
    }
    const removed = [...this.slots].filter(([id]) => !ids.includes(id));
    const reordered = ids.length !== this.chain.length || ids.some((id, i) => id !== this.chain[i]);
    if (reordered) this.wire(next);
    this.chain = ids;
    this.ordered = next;
    for (const [id, strip] of removed) {
      this.slots.delete(id);
      strip.dispose();
    }
    // Slot order decides how much latency sits ahead of each sidechain input.
    if (reordered) this.onLatency();
  }

  private wire(chain: readonly FxSlotStrip[]): void {
    this.taps.routeIn.disconnect();
    for (const s of this.slots.values()) s.output.disconnect();
    let prev: AudioNode = this.taps.routeIn;
    for (const s of chain) {
      prev.connect(s.input);
      prev = s.output;
    }
    prev.connect(this.taps.scTap);
  }
}
