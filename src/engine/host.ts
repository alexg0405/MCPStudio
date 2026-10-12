/**
 * Host side of the plugin SDK: param handles bound to document values, sample slots, transport
 * info. One HostImpl per plugin instance.
 */
import type { PluginInstance, Project, SampleId } from '@core/model/types';
import {
  encode,
  resolveValues,
  type ChannelInfo,
  type JsonValue,
  type ParamHandle,
  type ParamSignal,
  type ParamSpec,
  type ParamSpecs,
  type ParamValue,
  type PluginDef,
  type PluginHost,
  type SampleSlots,
  type TransportInfo,
} from '@agstudio/sdk';
import type { SampleCache } from './samples';

type Listener<T extends unknown[]> = (...args: T) => void;

class Emitter<T extends unknown[]> {
  private fns = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(...args: T): void {
    for (const fn of this.fns) fn(...args);
  }
  clear(): void {
    this.fns.clear();
  }
}

const identity = (v: number) => v;

class ParamHandleImpl<S extends ParamSpec> implements ParamHandle<S> {
  private bindings: { target: AudioParam; map: (v: number) => number }[] = [];
  private sources: { node: ConstantSourceNode; map: (v: number) => number }[] = [];
  private changes = new Emitter<[ParamValue, number]>();

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly spec: S,
    private current: ParamValue,
  ) {}

  get value() {
    return this.current as never;
  }

  private numeric(): number {
    return encode(this.spec, this.current);
  }

  bind(target: AudioParam, map: (v: number) => number = identity): () => void {
    const entry = { target, map };
    target.value = map(this.numeric());
    this.bindings.push(entry);
    return () => {
      this.bindings = this.bindings.filter((b) => b !== entry);
    };
  }

  signal(map: (v: number) => number = identity): ParamSignal {
    const node = new ConstantSourceNode(this.ctx, { offset: map(this.numeric()) });
    node.start();
    this.sources.push({ node, map });
    return {
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

  onChange(cb: (value: never, time: number) => void): () => void {
    return this.changes.on(cb as Listener<[ParamValue, number]>);
  }

  set(value: ParamValue, time: number): void {
    if (value === this.current) return;
    this.current = value;
    const v = this.numeric();
    const smooth = this.spec.type === 'float' ? (this.spec.smoothing ?? 0.008) / 3 : 0;
    for (const b of this.bindings) {
      if (smooth > 0) b.target.setTargetAtTime(b.map(v), time, smooth);
      else b.target.setValueAtTime(b.map(v), time);
    }
    for (const s of this.sources) {
      if (smooth > 0) s.node.offset.setTargetAtTime(s.map(v), time, smooth);
      else s.node.offset.setValueAtTime(s.map(v), time);
    }
    this.changes.emit(value, time);
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.node.stop();
      } catch {
        /* not started */
      }
      s.node.disconnect();
    }
    this.sources = [];
    this.bindings = [];
    this.changes.clear();
  }
}

export interface HostDeps {
  ctx: BaseAudioContext;
  def: PluginDef;
  data: PluginInstance;
  project: Project;
  samples: SampleCache;
  transport: TransportInfo;
  rootKey: number | null;
  offline: boolean;
  requestState(state: JsonValue): void;
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
  readonly offline: boolean;
  private readonly abort = new AbortController();
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
      this.params[key] = new ParamHandleImpl(deps.ctx, spec, values[key] as ParamValue);
    }
    this.stateValue = m.state;
    this.slots = { ...(deps.data.samples ?? {}) };
    this.rootKeyValue = deps.rootKey ?? 60;
    const readRootKey = () => this.rootKeyValue;
    this.channel =
      deps.rootKey === null
        ? null
        : {
            get rootKey() {
              return readRootKey();
            },
            onRootKeyChange: (cb) => this.rootKeyChanges.on(cb),
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
    for (const h of Object.values(this.params)) h.dispose();
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
