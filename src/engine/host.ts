/**
 * Host side of the plugin SDK: param handles bound to document values, sample slots, transport
 * info. One HostImpl per plugin instance.
 */
import { targetKey } from '@core/model/targets';
import type { PluginInstance, PluginOwner, Project, SampleId } from '@core/model/types';
import {
  encode,
  isAutomatable,
  resolveValues,
  type ChannelInfo,
  type JsonValue,
  type ParamSignal,
  type ParamSpec,
  type ParamSpecs,
  type ParamValue,
  type PluginDef,
  type PluginHost,
  type PluginTap,
  type SampleSlots,
  type TapOptions,
  type TransportInfo,
  type WorkletOptions,
  type WorkletPort,
} from '@agstudio/sdk';
import { PITCH_PARAM, type ProcessorInit } from '@agstudio/sdk/protocol';
import { Emitter } from './emitter';
import { ParamHandleImpl } from './param-handle';
import type { ParamRegistry } from './param-lane';
import type { SampleCache } from './samples';
import { NO_TAP, TapImpl } from './tap';
import { WorkletPortImpl } from './worklet-port';

export interface HostDeps {
  ctx: BaseAudioContext;
  def: PluginDef;
  data: PluginInstance;
  owner: PluginOwner;
  project: Project;
  samples: SampleCache;
  transport: TransportInfo;
  rootKey: number | null;
  /** The channel's pitch signal (instruments on a channel) and its value in cents at a time. */
  pitch?: ParamSignal & { pitchAt(time: number): number };
  offline: boolean;
  /** Where automatable params register (automation, controller links). */
  registry: ParamRegistry;
  requestState(state: JsonValue): void;
  /** Adds an AudioWorklet module to the context once. */
  loadModule(url: string): Promise<void>;
  /** Worklet ports are tracked so export can wait for them (sync barriers). */
  ports: Set<WorkletPortImpl>;
  reportFault(error: unknown): void;
  /**
   * The plugin tapped a node for its editor (`host.tap()`), or (live false) that tap went away with
   * the instance. Without it (and offline) taps are no-ops.
   */
  reportTap?(tap: TapImpl, live: boolean): void;
}

/** Stable per-instance seed so kernels' random numbers repeat across renders. */
function seedFor(owner: PluginOwner, pluginId: string): number {
  const key = `${pluginId}:${owner.kind === 'channel' ? owner.channelId : owner.slotId}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Applies migrate() when the saved version is older than the definition. */
export function migrated(def: PluginDef, data: PluginInstance): { params: Record<string, unknown>; state: unknown } {
  if (data.pluginVersion < def.version && def.migrate) {
    return def.migrate({ version: data.pluginVersion, params: data.params, state: data.state });
  }
  return { params: data.params, state: data.state ?? def.defaultState };
}

export class HostImpl implements PluginHost<ParamSpecs, unknown> {
  readonly audioContext: BaseAudioContext;
  readonly params: Record<string, ParamHandleImpl<ParamSpec>> = {};
  readonly transport: TransportInfo;
  readonly samples: SampleSlots;
  readonly channel: ChannelInfo | null;
  readonly sidechain: GainNode | null;
  readonly offline: boolean;
  private readonly abort = new AbortController();
  private readonly unregister: (() => void)[] = [];
  private stateValue: unknown;
  private slots: Record<string, SampleId>;
  private project: Project;
  private sampleChanges = new Map<string, Emitter<[AudioBuffer | null]>>();
  private rootKeyValue: number;
  private rootKeyChanges = new Emitter<[number]>();
  /** Set by the owner once the instance exists, so state changes reach it. */
  onState?: (state: unknown) => void;

  constructor(private readonly deps: HostDeps) {
    this.audioContext = deps.ctx;
    this.offline = deps.offline;
    this.transport = deps.transport;
    this.project = deps.project;
    const m = migrated(deps.def, deps.data);
    const values = resolveValues(deps.def.params as ParamSpecs, m.params);
    for (const [key, spec] of Object.entries(deps.def.params as ParamSpecs)) {
      const handle = new ParamHandleImpl(
        deps.ctx,
        targetKey({ kind: 'plugin', owner: deps.owner, paramId: key }),
        spec,
        values[key] as ParamValue,
      );
      this.params[key] = handle;
      if (isAutomatable(spec)) this.unregister.push(deps.registry.register(handle.lane));
    }
    this.sidechain = deps.def.kind === 'effect' && deps.def.sidechain ? new GainNode(deps.ctx) : null;
    this.stateValue = m.state;
    this.slots = { ...(deps.data.samples ?? {}) };
    this.rootKeyValue = deps.rootKey ?? 60;
    const readRootKey = () => this.rootKeyValue;
    const pitch = deps.pitch ?? silentSignal(deps.ctx);
    this.channel =
      deps.rootKey === null
        ? null
        : {
            get rootKey() {
              return readRootKey();
            },
            onRootKeyChange: (cb) => this.rootKeyChanges.on(cb),
            pitch,
            pitchAt: (time: number) => deps.pitch?.pitchAt(time) ?? 0,
          };
    this.samples = {
      get: (slot) => this.sampleFor(slot),
      load: (slot) => this.loadSample(slot),
      onChange: (slot, cb) => this.sampleEmitter(slot).on(cb),
      name: (slot) => {
        const id = this.slots[slot];
        return id ? (this.project.samples[id]?.name ?? null) : null;
      },
    };
  }

  get state(): unknown {
    return this.stateValue;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  updateState(next: unknown): void {
    this.deps.requestState(next as JsonValue);
  }

  private readonly myPorts = new Set<WorkletPortImpl>();
  private readonly taps = new Set<TapImpl>();

  tap(node: AudioNode, options?: TapOptions): PluginTap {
    const report = this.deps.reportTap;
    if (this.offline || !report || this.abort.signal.aborted) return NO_TAP;
    const tap = new TapImpl(this.deps.ctx, node, options);
    this.taps.add(tap);
    report(tap, true);
    return tap;
  }

  async worklet(opts: WorkletOptions = {}): Promise<WorkletPort> {
    const { def, ctx } = this.deps;
    if (!def.processor) throw new Error(`Plugin "${def.id}" has no processor module`);
    await this.deps.loadModule(def.processor);
    if (this.abort.signal.aborted) throw new Error('disposed');
    const parameterData: Record<string, number> = {};
    for (const [key, handle] of Object.entries(this.params)) parameterData[key] = encode(handle.spec, handle.value);
    const processorOptions: ProcessorInit = {
      kind: def.kind,
      state: this.stateValue,
      seed: seedFor(this.deps.owner, def.id),
    };
    const numberOfInputs = opts.numberOfInputs ?? (def.kind === 'effect' ? 1 : 0);
    const node = new AudioWorkletNode(ctx, opts.name ?? def.id, {
      numberOfInputs,
      numberOfOutputs: 1,
      outputChannelCount: opts.outputChannelCount ?? [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      parameterData,
      processorOptions,
    });
    for (const [key, handle] of Object.entries(this.params)) {
      const param = node.parameters.get(key);
      if (param) handle.bind(param);
    }
    // Instrument kernels read the channel pitch (cents) from a reserved param.
    const pitchParam = node.parameters.get(PITCH_PARAM);
    if (pitchParam && this.channel) this.channel.pitch.connect(pitchParam);
    const port = new WorkletPortImpl(
      node,
      ctx.sampleRate,
      (err) => this.deps.reportFault(err),
      (p) => {
        this.deps.ports.delete(p);
        this.myPorts.delete(p);
      },
    );
    this.deps.ports.add(port);
    this.myPorts.add(port);
    return port;
  }

  /** Pushes new document data (params, state, samples) into the running instance. */
  apply(data: PluginInstance, project: Project, time: number): void {
    this.project = project;
    const values = resolveValues(this.deps.def.params as ParamSpecs, data.params);
    for (const [key, handle] of Object.entries(this.params)) handle.set(values[key] as ParamValue, time);
    const nextState = data.state ?? this.deps.def.defaultState;
    if (nextState !== this.stateValue) {
      this.stateValue = nextState;
      this.onState?.(nextState);
    }
    const nextSlots = data.samples ?? {};
    const all = new Set([...Object.keys(this.slots), ...Object.keys(nextSlots)]);
    const prevSlots = this.slots;
    this.slots = { ...nextSlots };
    for (const slot of all) {
      if (prevSlots[slot] !== nextSlots[slot]) {
        void this.loadSample(slot).then((b) => this.sampleChanges.get(slot)?.emit(b));
      }
    }
  }

  setRootKey(rootKey: number): void {
    if (rootKey === this.rootKeyValue) return;
    this.rootKeyValue = rootKey;
    this.rootKeyChanges.emit(rootKey);
  }

  dispose(): void {
    this.abort.abort();
    // Ports the plugin forgot to dispose.
    for (const p of [...this.myPorts]) p.dispose();
    for (const t of this.taps) {
      t.dispose();
      this.deps.reportTap?.(t, false);
    }
    this.taps.clear();
    for (const off of this.unregister) off();
    for (const h of Object.values(this.params)) h.dispose();
    this.sidechain?.disconnect();
    for (const e of this.sampleChanges.values()) e.clear();
    this.rootKeyChanges.clear();
  }

  private sampleEmitter(slot: string) {
    let e = this.sampleChanges.get(slot);
    if (!e) {
      e = new Emitter();
      this.sampleChanges.set(slot, e);
    }
    return e;
  }

  private refFor(slot: string) {
    const id = this.slots[slot];
    return id ? this.project.samples[id] : undefined;
  }

  private sampleFor(slot: string): AudioBuffer | null {
    const ref = this.refFor(slot);
    return ref ? this.deps.samples.getSync(ref, this.deps.ctx.sampleRate) : null;
  }

  private async loadSample(slot: string): Promise<AudioBuffer | null> {
    const ref = this.refFor(slot);
    return ref ? this.deps.samples.load(ref, this.deps.ctx) : null;
  }
}

/** A pitch signal stuck at 0 cents (an instrument hosted outside a channel strip). */
function silentSignal(ctx: BaseAudioContext): ParamSignal {
  const node = new GainNode(ctx, { gain: 0 });
  return {
    node,
    connect(target: AudioParam) {
      node.connect(target);
      return () => {
        try {
          node.disconnect(target);
        } catch {
          /* already disconnected */
        }
      };
    },
  };
}
