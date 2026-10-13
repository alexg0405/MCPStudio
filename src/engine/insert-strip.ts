/**
 * Mixer inserts and their effect slots.
 *
 *   insert: in → slot 1 … slot N → StereoPanner → fader → mute ──► master input (or the master bus)
 *                                                          └─► ChannelSplitter → 2× AnalyserNode (meters)
 *   slot:   in ─► dry ──────────────────────────────────────► out
 *            ├─► fx.input … fx.output ─► wet ───────────────► out
 *            └─► latency delay ─► aligned dry ──────────────► out   (only for effects that report latency)
 *
 * Effects are created through HostImpl (owner { kind: 'fx', insertId, slotId }), asynchronously and
 * guarded by a generation token. While an effect loads, is missing, has failed or is disabled the
 * slot passes audio through (dry 1, wet 0, ~10 ms crossfade), and a disabled effect's input is
 * disconnected after the fade to save CPU. Reordering slots only rewires them.
 */
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import type { FxSlot, Insert, InsertId, PluginOwner, Project, SlotId } from '@core/model/types';
import type { EffectInstance, JsonValue } from '@agstudio/sdk';
import type { EngineCore } from './engine-core';
import { HostImpl } from './host';

/** Time constant for enable/disable, mix changes and instance swaps (≈ 10 ms crossfade). */
const SLOT_TAU = 0.01 / 3;
/** Time constant for fader/pan/mute moves (matches channel strips). */
const STRIP_TAU = 0.004;
/** After this long a bypassed effect stops receiving input (the fade is long over). */
const UNFEED_MS = 60;
/** A replaced instance keeps playing (fading out) this long before it is disposed. */
const RETIRE_MS = 80;
/** Analyser size for meters (≈ 43 ms at 48 kHz). */
export const METER_FRAMES = 2048;

const clamp = (v: number, lo: number, hi: number, fallback = lo) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/**
 * Moves an AudioParam to `value`: smoothed while the context runs, immediately before it has
 * started (offline renders apply the whole document at time 0, so they are exact and timer-free).
 */
function glide(param: AudioParam, value: number, ctx: BaseAudioContext, timeConstant: number): void {
  if (ctx.currentTime === 0) {
    param.cancelScheduledValues(0);
    param.setValueAtTime(value, 0);
  } else {
    param.setTargetAtTime(value, ctx.currentTime, timeConstant);
  }
}

function disconnectFrom(from: AudioNode, to: AudioNode): void {
  try {
    from.disconnect(to);
  } catch {
    /* not connected */
  }
}

/** One live effect instance and its wet (and latency-aligned dry) gains. */
class Lane {
  readonly wet: GainNode;
  readonly delay: DelayNode | null = null;
  readonly aligned: GainNode | null = null;
  private fed = false;

  constructor(
    ctx: BaseAudioContext,
    readonly inst: EffectInstance,
    readonly host: HostImpl,
    output: AudioNode,
    readonly latency: number,
  ) {
    this.wet = new GainNode(ctx, { gain: 0 });
    inst.output.connect(this.wet);
    this.wet.connect(output);
    if (latency > 0) {
      this.delay = new DelayNode(ctx, { maxDelayTime: Math.max(1, latency), delayTime: latency });
      this.aligned = new GainNode(ctx, { gain: 0 });
      this.delay.connect(this.aligned);
      this.aligned.connect(output);
    }
  }

  /** Connects or disconnects the slot input to the effect (and its aligned dry path). */
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
  }

  dispose(input: AudioNode): void {
    this.feed(input, false);
    disconnectFrom(this.inst.output, this.wet);
    this.wet.disconnect();
    this.delay?.disconnect();
    this.aligned?.disconnect();
    try {
      this.inst.dispose();
    } catch (err) {
      console.error('effect dispose failed', err);
    }
    this.host.dispose();
  }
}

/** One effect slot of an insert. */
export class FxSlotStrip {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly dry: GainNode;
  /** The current instance (null while loading, or when missing/failed). */
  private lane: Lane | null = null;
  /** Replaced instances fading out. */
  private readonly retiring = new Set<Lane>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private unfeedTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private slot: FxSlot;
  private project: Project;
  private readonly owner: PluginOwner;
  /** True when the plugin is missing or failed (the slot passes audio through; data is kept). */
  faulted = false;

  constructor(
    private readonly core: EngineCore,
    insertId: InsertId,
    slot: FxSlot,
    project: Project,
  ) {
    const ctx = core.ctx;
    this.slot = slot;
    this.project = project;
    this.owner = { kind: 'fx', insertId, slotId: slot.id };
    this.input = new GainNode(ctx);
    this.output = new GainNode(ctx);
    this.dry = new GainNode(ctx, { gain: 1 });
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.load();
  }

  get ready(): Promise<void> {
    return this.pending;
  }

  get pluginId(): string {
    return this.slot.plugin.pluginId;
  }

  /** Seconds the effect keeps ringing after its input stops (0 when bypassed). */
  get tailTime(): number {
    const t = this.live ? this.lane?.inst.tailTime : 0;
    return typeof t === 'number' && Number.isFinite(t) ? Math.max(0, t) : 0;
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
    if (prev.plugin !== next.plugin) this.lane?.host.apply(next.plugin, project, this.core.ctx.currentTime);
    if (prev.enabled !== next.enabled || prev.mix !== next.mix) this.applyGains();
  }

  /** The project's sample table changed (effects with sample slots reload them). */
  samplesChanged(project: Project): void {
    this.project = project;
    this.lane?.host.apply(this.slot.plugin, project, this.core.ctx.currentTime);
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
    for (const lane of this.retiring) lane.dispose(this.input);
    this.retiring.clear();
    this.lane?.dispose(this.input);
    this.lane = null;
    this.input.disconnect();
    this.dry.disconnect();
    this.output.disconnect();
  }

  private get live(): boolean {
    return !!this.lane && this.slot.enabled && !this.faulted;
  }

  /** Dry/wet gains for the current state, then (dis)connects the effect input. */
  private applyGains(): void {
    const ctx = this.core.ctx;
    const lane = this.live ? this.lane : null;
    const mix = clamp(this.slot.mix, 0, 1, 1);
    glide(this.dry.gain, lane ? (lane.aligned ? 0 : 1 - mix) : 1, ctx, SLOT_TAU);
    const lanes = this.lane ? [this.lane, ...this.retiring] : [...this.retiring];
    for (const l of lanes) {
      const on = l === lane;
      glide(l.wet.gain, on ? mix : 0, ctx, SLOT_TAU);
      if (l.aligned) glide(l.aligned.gain, on ? 1 - mix : 0, ctx, SLOT_TAU);
    }
    if (this.unfeedTimer) {
      clearTimeout(this.unfeedTimer);
      this.unfeedTimer = null;
    }
    if (lane) lane.feed(this.input, true);
    else if (this.lane) this.unfeedLater(this.lane);
  }

  /** Stops feeding a bypassed effect once its fade-out is over (immediately offline). */
  private unfeedLater(lane: Lane): void {
    if (this.core.offline || this.core.ctx.currentTime === 0) {
      lane.feed(this.input, false);
      return;
    }
    this.unfeedTimer = setTimeout(() => {
      this.unfeedTimer = null;
      if (this.lane === lane && !this.live) lane.feed(this.input, false);
    }, UNFEED_MS);
  }

  /** Fades an instance out and disposes it (immediately before the context runs). */
  private retire(lane: Lane): void {
    if (this.lane === lane) this.lane = null;
    if (this.core.offline || this.core.ctx.currentTime === 0) {
      lane.dispose(this.input);
      return;
    }
    this.retiring.add(lane);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.retiring.delete(lane);
      lane.dispose(this.input);
    }, RETIRE_MS);
    this.timers.add(timer);
  }

  private load(): void {
    const gen = ++this.generation;
    if (this.lane) this.retire(this.lane);
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
      requestState: (state: JsonValue) => this.core.requestState(this.owner, state),
      owner: this.owner,
      loadModule: (url) => this.core.loadModule(url),
      ports: this.core.ports,
      reportFault: (err) => {
        if (gen === this.generation) this.fault(err);
      },
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
        const latency = typeof inst.latency === 'number' && Number.isFinite(inst.latency) ? inst.latency : 0;
        this.lane = new Lane(ctx, inst, host, this.output, clamp(latency, 0, 1));
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

/** A mixer insert (the master uses the same strip, feeding the limiter instead of the master). */
export class InsertStrip {
  readonly input: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly fader: GainNode;
  private readonly mute: GainNode;
  private readonly splitter: ChannelSplitterNode | null = null;
  private readonly meters: readonly AnalyserNode[] = [];
  private readonly slots = new Map<SlotId, FxSlotStrip>();
  private chain: readonly SlotId[] = [];
  private insert: Insert;
  private muted = false;

  constructor(
    private readonly core: EngineCore,
    insert: Insert,
    project: Project | null,
    destination: AudioNode,
    /** The engine keeps one input node per insert id (it outlives the strip); dispose() disconnects it. */
    input: GainNode = new GainNode(core.ctx),
  ) {
    const ctx = core.ctx;
    this.insert = insert;
    this.input = input;
    this.panner = new StereoPannerNode(ctx, { pan: clamp(insert.pan, -1, 1, 0) });
    this.fader = new GainNode(ctx, { gain: clamp(insert.volume, 0, MAX_INSERT_VOLUME) });
    this.mute = new GainNode(ctx);
    this.input.connect(this.panner);
    this.panner.connect(this.fader);
    this.fader.connect(this.mute);
    this.mute.connect(destination);
    // Meters only matter while someone is looking: offline renders skip them.
    if (!core.offline) {
      this.splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
      this.meters = [0, 1].map(() => new AnalyserNode(ctx, { fftSize: METER_FRAMES, smoothingTimeConstant: 0 }));
      this.mute.connect(this.splitter);
      this.meters.forEach((m, i) => this.splitter?.connect(m, i));
    }
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

  update(next: Insert, project: Project): void {
    const prev = this.insert;
    if (prev === next) return;
    this.insert = next;
    const ctx = this.core.ctx;
    if (prev.volume !== next.volume) glide(this.fader.gain, clamp(next.volume, 0, MAX_INSERT_VOLUME), ctx, STRIP_TAU);
    if (prev.pan !== next.pan) glide(this.panner.pan, clamp(next.pan, -1, 1, 0), ctx, STRIP_TAU);
    if (prev.fx !== next.fx) this.syncSlots(next.fx, project);
  }

  samplesChanged(project: Project): void {
    for (const s of this.slots.values()) s.samplesChanged(project);
  }

  /** Rebuilds effects whose plugin definition changed (hot reload, install/uninstall). */
  pluginsChanged(ids: ReadonlySet<string>, project: Project): void {
    for (const s of this.slots.values()) if (ids.has(s.pluginId)) s.reload(project);
  }

  setMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    glide(this.mute.gain, muted ? 0 : 1, this.core.ctx, STRIP_TAU);
  }

  /** Writes the left/right peak of the last METER_FRAMES frames into out[at], out[at + 1]. */
  readPeaks(scratch: Float32Array<ArrayBuffer>, out: Float32Array, at: number): void {
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

  dispose(): void {
    for (const s of this.slots.values()) s.dispose();
    this.slots.clear();
    this.input.disconnect();
    this.panner.disconnect();
    this.fader.disconnect();
    this.mute.disconnect();
    this.splitter?.disconnect();
    for (const m of this.meters) m.disconnect();
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
        strip = new FxSlotStrip(this.core, this.insert.id, data, project);
        this.slots.set(data.id, strip);
      }
      next.push(strip);
      ids.push(data.id);
    }
    const removed = [...this.slots].filter(([id]) => !ids.includes(id));
    if (ids.length !== this.chain.length || ids.some((id, i) => id !== this.chain[i])) this.wire(next);
    this.chain = ids;
    for (const [id, strip] of removed) {
      this.slots.delete(id);
      strip.dispose();
    }
  }

  private wire(chain: readonly FxSlotStrip[]): void {
    this.input.disconnect();
    for (const s of this.slots.values()) s.output.disconnect();
    let prev: AudioNode = this.input;
    for (const s of chain) {
      prev.connect(s.input);
      prev = s.output;
    }
    prev.connect(this.panner);
  }
}
