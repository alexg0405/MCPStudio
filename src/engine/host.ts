/**
 * Host side of the plugin SDK: param handles bound to document values, sample slots (host-samples.ts), transport
 * info and the worklet (host-worklet-node.ts). One HostImpl per plugin instance.
 */
import { targetKey } from '@core/model/targets';
import { lowestNoteKey } from '@core/query/queries';
import type { PluginInstance, PluginOwner, Project } from '@core/model/types';
import {
  encode,
  isAutomatable,
  resolveValues,
  type ChannelInfo,
  type JsonValue,
  type NoteFeed,
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
import { PITCH_PARAM } from '@agstudio/sdk/protocol';
import { Emitter } from './emitter';
import { HostSampleSlots } from './host-samples';
import { createPluginNode } from './host-worklet-node';
import type { NoteFeedHub } from './note-feed';
import { ParamHandleImpl } from './param-handle';
import type { ParamRegistry } from './param-lane';
import type { SampleCache } from './samples';
import { NO_TAP, TapImpl } from './tap';
import { WorkletPortImpl } from './worklet-port';

/** What a plugin host needs from the engine for one plugin instance. */
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
  /** Effects that declare `notes`: where the instrument channels' notes come from. */
  noteFeed?: NoteFeedHub;
  reportFault(error: unknown): void;
  /**
   * The plugin tapped a node for its editor (`host.tap()`), or (live false) that tap went away with
   * the instance. Without it (and offline) taps are no-ops.
   */
  reportTap?(tap: TapImpl, live: boolean): void;
  /**
   * True while no automation drives this instance's params: its worklet then runs as the kernel's
   * lite processor (no AudioParams: every param arrives as an event), which costs the audio thread
   * much less. Absent: always the full processor.
   */
  lite?(): boolean;
}

/** The root key a channel without one reports (middle C). */
const DEFAULT_ROOT_KEY = 60;

/** Applies migrate() when the saved version is older than the definition. */
export function migrated(def: PluginDef, data: PluginInstance): { params: Record<string, unknown>; state: unknown } {
  if (data.pluginVersion < def.version && def.migrate) {
    return def.migrate({ version: data.pluginVersion, params: data.params, state: data.state });
  }
  return { params: data.params, state: data.state ?? def.defaultState };
}

/** What a plugin instance sees as `host` (the SDK's PluginHost): its params, samples, transport info and worklet. */
export class HostImpl implements PluginHost<ParamSpecs, unknown> {
  readonly audioContext: BaseAudioContext;
  readonly params: Record<string, ParamHandleImpl<ParamSpec>> = {};
  readonly transport: TransportInfo;
  readonly samples: SampleSlots;
  readonly channel: ChannelInfo | null;
  readonly sidechain: GainNode | null;
  readonly notes: NoteFeed | null;
  readonly offline: boolean;
  private readonly abort = new AbortController();
  private readonly unregisterLanes: (() => void)[] = [];
  private stateValue: unknown;
  private project: Project;
  private readonly sampleSlots: HostSampleSlots;
  private rootKeyValue: number;
  private readonly rootKeyChanges = new Emitter<[number]>();
  /** Set by the owner once the instance exists, so state changes reach it. */
  onState?: (state: unknown) => void;
  /** The worklet ports this instance made (ports the plugin forgot to dispose are disposed with it). */
  private readonly myPorts = new Set<WorkletPortImpl>();
  private readonly taps = new Set<TapImpl>();
  /** True while this instance's worklet is the kernel's lite processor (see HostDeps.lite). */
  lite = false;
  /** Seconds this instance sits behind the song's clock (see `AutomatableParam.shift`). */
  private shiftSec = 0;
  /** The mixer is not processing this instance now (see setParked); taps made meanwhile start out parked. */
  private isParked = false;

  constructor(private readonly deps: HostDeps) {
    this.audioContext = deps.ctx;
    this.offline = deps.offline;
    this.transport = deps.transport;
    this.project = deps.project;
    const migratedData = migrated(deps.def, deps.data);
    this.createParams(resolveValues(deps.def.params as ParamSpecs, migratedData.params));
    this.sidechain = deps.def.kind === 'effect' && deps.def.sidechain ? new GainNode(deps.ctx) : null;
    this.notes = this.createNoteFeed();
    this.stateValue = migratedData.state;
    this.sampleSlots = new HostSampleSlots(deps.ctx, deps.samples, deps.data, deps.project);
    this.samples = this.sampleSlots.api;
    this.rootKeyValue = deps.rootKey ?? DEFAULT_ROOT_KEY;
    this.channel = deps.rootKey === null ? null : this.createChannelInfo();
  }

  /** One handle per param of the definition; the automatable ones register where automation and controllers find them. */
  private createParams(values: Record<string, unknown>): void {
    const { def, ctx, owner, registry } = this.deps;
    for (const [key, spec] of Object.entries(def.params as ParamSpecs)) {
      const handle = new ParamHandleImpl(
        ctx,
        targetKey({ kind: 'plugin', owner, paramId: key }),
        spec,
        values[key] as ParamValue,
      );
      this.params[key] = handle;
      if (isAutomatable(spec)) this.unregisterLanes.push(registry.register(handle.lane));
    }
  }

  /** The notes of the instrument channels, for effects that follow a melody (null for the others). */
  private createNoteFeed(): NoteFeed | null {
    const { def, noteFeed } = this.deps;
    const feed = def.kind === 'effect' && def.notes ? noteFeed : undefined;
    if (!feed) return null;
    // The effect's own delay compensation applies to the notes as it does to its audio.
    return {
      listen: (position, fn) => feed.listen(position, (note) => fn({ ...note, time: note.time + this.shiftSec })),
      channelName: (position) => feed.channelName(position),
    };
  }

  /** What an instrument knows about the channel it plays on. */
  private createChannelInfo(): ChannelInfo {
    const deps = this.deps;
    const pitch = deps.pitch ?? silentSignal(deps.ctx);
    // The getters read the host's current values, so a plugin that holds on to the object follows edits.
    const readRootKey = () => this.rootKeyValue;
    const readProject = () => this.project;
    return {
      get rootKey() {
        return readRootKey();
      },
      onRootKeyChange: (callback) => this.rootKeyChanges.on(callback),
      pitch,
      pitchAt: (time: number) => deps.pitch?.pitchAt(time) ?? 0,
      get lowestKey() {
        return deps.owner.kind === 'channel' ? lowestNoteKey(readProject(),deps.owner.channelId) : null;
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

  tap(node: AudioNode, options?: TapOptions): PluginTap {
    const report = this.deps.reportTap;
    if (this.offline || !report || this.abort.signal.aborted) return NO_TAP;
    const tap = new TapImpl(this.deps.ctx, node, options);
    if (this.isParked) tap.setParked(true);
    this.taps.add(tap);
    report(tap, true);
    return tap;
  }

  get shift(): number {
    return this.shiftSec;
  }

  /**
   * The mixer stopped (or resumed) pulling this instance's audio because nothing can sound (engine/idle-parking.ts).
   * Its editor taps stop listening meanwhile (a listening analyser would keep the node being processed) and read silence.
   */
  setParked(isParked: boolean): void {
    this.isParked = isParked;
    for (const tap of this.taps) tap.setParked(isParked);
  }

  /**
   * The mixer's delay compensation holds this instance's sound back by `seconds` after the time the song schedules it:
   * its automation lanes and its transport anchors follow, so they stay with the notes and the audio.
   */
  setShift(seconds: number): void {
    if (seconds === this.shiftSec) return;
    this.shiftSec = seconds;
    for (const handle of Object.values(this.params)) handle.lane.shift = seconds;
    for (const port of this.myPorts) port.shift = seconds;
  }

  async worklet(options: WorkletOptions = {}): Promise<WorkletPort> {
    const { def, ctx } = this.deps;
    if (!def.processor) throw new Error(`Plugin "${def.id}" has no processor module`);
    await this.deps.loadModule(def.processor);
    if (this.abort.signal.aborted) throw new Error('disposed');
    const { node, messageNames, isLite } = createPluginNode({
      ctx,
      def,
      owner: this.deps.owner,
      params: this.params,
      state: this.stateValue,
      options,
      mayBeLite: this.deps.lite?.() === true,
    });
    if (isLite) this.lite = true;
    // Instrument kernels read the channel pitch (cents) from a reserved param.
    const pitchParam = node.parameters.get(PITCH_PARAM);
    if (pitchParam && this.channel) this.channel.pitch.connect(pitchParam);
    const stopListening = this.forwardParamChanges(messageNames, (index, value, time) => port.param(index, value, time));
    const port = new WorkletPortImpl(
      node,
      ctx.sampleRate,
      (err) => this.deps.reportFault(err),
      (closed) => {
        this.deps.ports.delete(closed);
        this.myPorts.delete(closed);
        stopListening();
      },
      def.kind === 'instrument',
    );
    port.shift = this.shiftSec;
    this.deps.ports.add(port);
    this.myPorts.add(port);
    return port;
  }

  /** Sends every later change of the params that travel as events to the processor; returns the way to stop. */
  private forwardParamChanges(
    messageNames: readonly string[],
    send: (index: number, encoded: number, time: number) => void,
  ): () => void {
    const unsubscribers = messageNames.map((key, index) => {
      const handle = this.params[key];
      if (!handle) return () => {};
      return handle.onChange((value, time) => send(index, encode(handle.spec, value as ParamValue), time));
    });
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
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
    this.sampleSlots.apply(data, project);
  }

  setRootKey(rootKey: number): void {
    if (rootKey === this.rootKeyValue) return;
    this.rootKeyValue = rootKey;
    this.rootKeyChanges.emit(rootKey);
  }

  dispose(): void {
    this.abort.abort();
    this.sampleSlots.dispose();
    // Ports the plugin forgot to dispose.
    for (const port of [...this.myPorts]) port.dispose();
    for (const tap of this.taps) {
      tap.dispose();
      this.deps.reportTap?.(tap, false);
    }
    this.taps.clear();
    for (const unregister of this.unregisterLanes) unregister();
    for (const handle of Object.values(this.params)) handle.dispose();
    this.sidechain?.disconnect();
    this.rootKeyChanges.clear();
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
