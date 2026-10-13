/**
 * The audio engine: owns the AudioContext (or an OfflineAudioContext for export), mirrors the
 * project document into a Web Audio graph and drives the lookahead transport.
 */
import type { DocChange } from '@core/history/history';
import { makeInsert } from '@core/model/defaults';
import {
  MASTER,
  type ChannelId,
  type InsertId,
  type PluginOwner,
  type Project,
  type SampleRef,
} from '@core/model/types';
import { effectivelyMutedInserts } from '@core/query/mixer';
import { effectivelyMuted } from '@core/query/queries';
import { PPQ, ticksPerBar } from '@core/time/ppq';
import type { JsonValue, TransportInfo } from '@agstudio/sdk';
import type { EngineApi, EngineOptions, EngineState, EngineStats, PluginResolver, TransportView } from './api';
import { ChannelStrip } from './channel-strip';
import type { EngineCore } from './engine-core';
import { InsertStrip, METER_FRAMES } from './insert-strip';
import { SampleCache } from './samples';
import { decodeAudio } from './decode';
import type { Timeline } from './sched/core';
import { patternModeSource, songModeSource, type EventSource } from './sched/events';
import { Transport, type TransportSink } from './sched/transport';
import { LIMITER_ID } from './limiter-id';
import type { WorkletPortImpl } from './worklet-port';
import limiterUrl from './limiter.worklet.ts?worker&url';

const PREVIEW_ID_BASE = 2 ** 30;
/** Used when a document has no master insert (repair adds one; the engine never runs without). */
const DEFAULT_MASTER = makeInsert(MASTER, 'Master');

class TempoInfo implements TransportInfo {
  readonly ppq = PPQ;
  private fns = new Set<(bpm: number) => void>();
  constructor(public bpm: number) {}
  onTempo(cb: (bpm: number) => void): () => void {
    this.fns.add(cb);
    return () => this.fns.delete(cb);
  }
  setBpm(bpm: number): void {
    if (bpm === this.bpm) return;
    this.bpm = bpm;
    for (const fn of this.fns) fn(bpm);
  }
}

export class Engine implements EngineApi, EngineCore {
  readonly ctx: BaseAudioContext;
  readonly plugins: PluginResolver;
  readonly samples: SampleCache;
  readonly offline: boolean;
  readonly transportInfo: TempoInfo;
  /** Post-master bus: master insert + previews → safety limiter → destination. */
  private readonly masterOut: GainNode;
  private readonly previewBus: GainNode;
  private readonly master: InsertStrip;
  private readonly inserts = new Map<InsertId, InsertStrip>();
  /** Persistent input node per insert id (see inputNode). */
  private readonly insertInputs = new Map<InsertId, GainNode>();
  private readonly meterScratch = new Float32Array(METER_FRAMES);
  private readonly strips = new Map<ChannelId, ChannelStrip>();
  private project: Project | null = null;
  private view: TransportView = { mode: 'pattern', patternId: null, loop: null };
  private readonly transport: Transport;
  private clock: Worker | null = null;
  private readonly listeners = new Set<() => void>();
  private previewSeq = PREVIEW_ID_BASE;
  private previewSource: AudioBufferSourceNode | null = null;
  private previewToken = 0;
  private faults = 0;
  private muteKey = '';
  private lastLate = 0;
  private readonly modules = new Map<string, Promise<void>>();
  readonly ports = new Set<WorkletPortImpl>();
  private readonly initDone: Promise<void>;
  private limiter: AudioWorkletNode | null = null;

  constructor(
    ctx: BaseAudioContext,
    private readonly opts: EngineOptions,
    offline = false,
  ) {
    this.ctx = ctx;
    this.offline = offline;
    this.plugins = opts.plugins;
    this.samples = new SampleCache(opts.samples);
    this.transportInfo = new TempoInfo(130);
    this.masterOut = new GainNode(ctx);
    this.previewBus = new GainNode(ctx, { gain: 0.8 });
    this.masterOut.connect(ctx.destination);
    this.previewBus.connect(this.masterOut);
    // The master insert exists before any document so channels and inserts always have a target.
    this.master = new InsertStrip(this, DEFAULT_MASTER, null, this.masterOut);
    this.inserts.set(MASTER, this.master);

    const sink: TransportSink = {
      noteOn: (cid, e) => this.strips.get(cid)?.noteOn(e),
      noteOff: (cid, e) => this.strips.get(cid)?.noteOff(e),
      allNotesOff: (time) => {
        for (const s of this.strips.values()) s.allNotesOff(time);
      },
    };
    const empty: EventSource = { project: null as unknown as Project, clips: [] };
    this.transport = new Transport(ctx, sink, empty, { spt: 1, loop: { start: 0, end: 1 }, endTick: 1 });
    this.transport.onEnded = () => this.emit();

    if (!offline && typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
      ctx.addEventListener('statechange', () => this.emit());
    }
    this.initDone = this.init();
  }

  /** Inserts the master safety limiter once its worklet module has loaded. */
  private async init(): Promise<void> {
    try {
      await this.loadModule(limiterUrl);
      const node = new AudioWorkletNode(this.ctx, LIMITER_ID, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { kind: 'effect', state: undefined, seed: 1 },
      });
      this.masterOut.disconnect();
      this.masterOut.connect(node).connect(this.ctx.destination);
      this.limiter = node;
    } catch (err) {
      console.warn('[agstudio] safety limiter unavailable; master is unprotected', err);
    }
  }

  loadModule(url: string): Promise<void> {
    let p = this.modules.get(url);
    if (!p) {
      p = this.ctx.audioWorklet.addModule(url);
      this.modules.set(url, p);
      p.catch(() => this.modules.delete(url));
    }
    return p;
  }

  /** Resolves once every worklet processor has handled all messages sent so far (export barrier). */
  async syncWorklets(timeoutMs = 2000): Promise<boolean> {
    const all = Promise.all([...this.ports].map((p) => p.sync())).then(() => true);
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs));
    return Promise.race([all, timeout]);
  }

  /** Plugin definitions changed (hot reload, plugin added/removed): rebuild the affected instances. */
  pluginsChanged(ids: readonly string[]): void {
    if (!this.project || ids.length === 0) return;
    const set = new Set(ids);
    for (const strip of this.strips.values()) if (set.has(strip.pluginId)) strip.reload(this.project);
    for (const insert of this.inserts.values()) insert.pluginsChanged(set, this.project);
  }

  /** A realtime engine with its own AudioContext. */
  static realtime(opts: EngineOptions): Engine {
    return new Engine(new AudioContext({ latencyHint: 'interactive' }), opts, false);
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get state(): EngineState {
    return this.ctx.state as EngineState;
  }

  get playing(): boolean {
    return this.transport.playing;
  }

  async resume(): Promise<void> {
    if (this.ctx instanceof AudioContext && this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Resolves when the master chain and every plugin instance (instruments and effects) have loaded. */
  async ready(): Promise<void> {
    await this.initDone;
    await Promise.all([
      ...[...this.strips.values()].map((s) => s.ready),
      ...[...this.inserts.values()].map((s) => s.ready),
    ]);
  }

  // ---- Document mirroring ----

  applyDocChange(change: DocChange): void {
    const prev = change.origin === 'load' ? null : this.project;
    this.reconcile(prev, change.next);
  }

  private reconcile(prev: Project | null, next: Project): void {
    if (prev === next) return;
    this.project = next;
    if (!prev || prev.transport.bpm !== next.transport.bpm) this.transportInfo.setBpm(next.transport.bpm);

    // Inserts first (channels connect to them), removals last.
    const removedInserts = this.reconcileMixer(prev, next);

    if (!prev || prev.channels !== next.channels || prev.samples !== next.samples) {
      const muted = effectivelyMuted(next.channels);
      for (const id of next.channelOrder) {
        const ch = next.channels[id];
        if (!ch || ch.kind === 'automation') continue;
        const strip = this.strips.get(id);
        if (!strip) this.strips.set(id, new ChannelStrip(this, ch, next));
        else {
          const prevCh = prev?.channels[id];
          if (prevCh !== ch) strip.update(ch, next);
          else if (prev && prev.samples !== next.samples) strip.samplesChanged(next);
        }
        this.strips.get(id)?.setMuted(muted.has(id));
      }
      for (const [id, strip] of this.strips) {
        const kind = next.channels[id]?.kind;
        if (kind !== 'instrument' && kind !== 'audioClip') {
          strip.dispose();
          this.strips.delete(id);
        }
      }
    }
    // Insert removals last; anything still routed to a removed insert falls back to the master.
    for (const strip of removedInserts) this.removeInsertStrip(strip);

    const muteKey = [...effectivelyMuted(next.channels)].sort().join(',');
    const schedulingChanged =
      !prev ||
      prev.patterns !== next.patterns ||
      prev.playlist !== next.playlist ||
      prev.transport !== next.transport ||
      prev.channelOrder !== next.channelOrder ||
      muteKey !== this.muteKey;
    this.muteKey = muteKey;
    if (schedulingChanged) this.updateModel();
  }

  /**
   * Keyed add/update of inserts (and their effect slots) plus effective mutes. Strips of removed
   * inserts are returned, still connected, for removeInsertStrip() once channels are reconciled.
   */
  private reconcileMixer(prev: Project | null, next: Project): InsertStrip[] {
    const removed: InsertStrip[] = [];
    if (!prev || prev.mixer !== next.mixer) {
      const inserts = next.mixer.inserts;
      for (const id of Object.keys(inserts) as InsertId[]) {
        const insert = inserts[id];
        if (!insert) continue;
        const strip = this.inserts.get(id);
        if (strip) strip.update(insert, next);
        else {
          // Take the insert's input over from the master fallback.
          const input = this.inputNode(id);
          input.disconnect();
          this.inserts.set(id, new InsertStrip(this, insert, next, this.master.input, input));
        }
      }
      if (!inserts[MASTER]) this.master.update(DEFAULT_MASTER, next);
      for (const [id, strip] of this.inserts) {
        if (id === MASTER || inserts[id]) continue;
        this.inserts.delete(id);
        removed.push(strip);
      }
      const muted = effectivelyMutedInserts(inserts);
      for (const [id, strip] of this.inserts) strip.setMuted(muted.has(id));
    }
    if (prev && prev.samples !== next.samples) for (const strip of this.inserts.values()) strip.samplesChanged(next);
    return removed;
  }

  /**
   * The input node of insert `id`, which channels connect to. It outlives the insert's strip: while
   * the insert doesn't exist (not created yet, deleted, or an unknown id) it feeds the master, so
   * deleting or restoring an insert never has to reconnect channels.
   */
  private inputNode(id: InsertId): GainNode {
    let node = this.insertInputs.get(id);
    if (!node) {
      node = new GainNode(this.ctx);
      node.connect(this.master.input);
      this.insertInputs.set(id, node);
    }
    return node;
  }

  private removeInsertStrip(strip: InsertStrip): void {
    strip.dispose();
    this.insertInputs.get(strip.id)?.connect(this.master.input);
  }

  setTransportView(view: TransportView): void {
    if (
      view.mode === this.view.mode &&
      view.patternId === this.view.patternId &&
      view.loop?.start === this.view.loop?.start &&
      view.loop?.end === this.view.loop?.end
    )
      return;
    this.view = view;
    this.updateModel();
  }

  private model(): { source: EventSource; timeline: Timeline } | null {
    const p = this.project;
    if (!p) return null;
    const spt = 60 / (p.transport.bpm * PPQ);
    if (this.view.mode === 'song') {
      // Song mode loops the loop region, or the whole song (FL's default).
      const { source, length } = songModeSource(p);
      const songEnd = Math.max(length, ticksPerBar(p.transport.timeSig));
      const loop =
        this.view.loop && this.view.loop.end > this.view.loop.start ? this.view.loop : { start: 0, end: songEnd };
      return { source, timeline: { spt, loop, endTick: songEnd } };
    }
    const { source, length } = patternModeSource(p, this.view.patternId ?? p.patternOrder[0] ?? null);
    return { source, timeline: { spt, loop: { start: 0, end: length }, endTick: length } };
  }

  private updateModel(): void {
    const m = this.model();
    if (m) this.transport.setModel(m.source, m.timeline);
  }

  // ---- EngineCore ----

  /** Where a channel routed to `id` connects (unknown inserts play through the master). */
  insertInput(id: InsertId): AudioNode {
    return id === MASTER ? this.master.input : this.inputNode(id);
  }

  requestState(owner: PluginOwner, state: JsonValue): void {
    this.opts.onPluginStateRequest?.(owner, state);
  }

  reportFault(owner: PluginOwner, pluginId: string, err: unknown): void {
    this.faults++;
    this.opts.onPluginFault?.(owner, pluginId, err);
    this.emit();
  }

  // ---- Transport ----

  play(fromTick = 0): void {
    if (!this.project) return;
    void this.resume();
    this.updateModel();
    this.transport.start(fromTick, this.ctx.currentTime + 0.05);
    this.startClock();
    this.emit();
  }

  stop(): void {
    this.transport.stop(0);
    this.stopClock();
    this.emit();
  }

  /** Offline rendering: start the transport on the virtual clock (call pumpOffline per chunk). */
  startOffline(fromTick: number, at: number): void {
    this.updateModel();
    this.transport.start(fromTick, at);
  }

  pumpOffline(horizon: number): void {
    this.transport.pump(horizon);
  }

  playhead(): number {
    return this.transport.positionAt(this.audibleTime());
  }

  playheadIteration(): number {
    return this.transport.iterationAt(this.audibleTime());
  }

  /** Context time currently coming out of the speakers. */
  private audibleTime(): number {
    const ctx = this.ctx;
    if (typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
        return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      }
      return ctx.currentTime - (ctx.outputLatency || 0) - ctx.baseLatency;
    }
    return ctx.currentTime;
  }

  private startClock(): void {
    if (this.offline) return;
    if (!this.clock) {
      this.clock = new Worker(new URL('./sched/clock.worker.ts', import.meta.url), { type: 'module' });
      this.clock.onmessage = () => this.tick();
    }
    this.clock.postMessage({ cmd: 'start', interval: 25 });
  }

  private stopClock(): void {
    this.clock?.postMessage({ cmd: 'stop' });
  }

  private tick(): void {
    const wasPlaying = this.transport.playing;
    this.transport.pump();
    // Raise the lookahead when notes arrive late (main-thread jank).
    if (this.transport.lateEvents > this.lastLate) {
      this.lastLate = this.transport.lateEvents;
      this.transport.lookahead = Math.min(0.25, this.transport.lookahead * 1.5);
    }
    if (wasPlaying && !this.transport.playing) {
      this.stopClock();
      this.emit();
    }
  }

  // ---- Previews ----

  previewNoteOn(channelId: ChannelId, key: number, velocity = 0.8): number {
    void this.resume();
    const noteId = ++this.previewSeq;
    this.strips.get(channelId)?.noteOn({ time: this.ctx.currentTime, noteId, key, velocity });
    return noteId;
  }

  previewNoteOff(channelId: ChannelId, noteId: number): void {
    this.strips.get(channelId)?.noteOff({ time: this.ctx.currentTime, noteId, key: 0 });
  }

  previewSample(ref: Pick<SampleRef, 'source' | 'name'>): void {
    void this.resume();
    void this.samples.load(ref, this.ctx).then((buffer) => {
      if (buffer) this.playPreview(buffer);
    });
  }

  async previewAudio(bytes: ArrayBuffer): Promise<boolean> {
    void this.resume();
    const token = ++this.previewToken;
    let buffer: AudioBuffer;
    try {
      buffer = await decodeAudio(this.ctx, bytes);
    } catch {
      return false;
    }
    // A newer preview (or a stop) was requested while this one decoded.
    if (token === this.previewToken) this.playPreview(buffer);
    return true;
  }

  stopPreview(): void {
    this.previewToken++;
    try {
      this.previewSource?.stop();
    } catch {
      /* already stopped */
    }
    this.previewSource = null;
  }

  private playPreview(buffer: AudioBuffer): void {
    this.stopPreview();
    const src = new AudioBufferSourceNode(this.ctx, { buffer });
    src.connect(this.previewBus);
    src.onended = () => src.disconnect();
    src.start();
    this.previewSource = src;
  }

  // ---- Meters ----

  readMeters(order: readonly InsertId[], out: Float32Array): void {
    for (let i = 0; i < order.length; i++) {
      const strip = this.inserts.get(order[i] as InsertId);
      if (strip) strip.readPeaks(this.meterScratch, out, i * 2);
      else if (i * 2 + 1 < out.length) {
        out[i * 2] = 0;
        out[i * 2 + 1] = 0;
      }
    }
  }

  // ---- Status ----

  stats(): EngineStats {
    const ctx = this.ctx;
    const realtime = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
    return {
      state: this.state,
      sampleRate: ctx.sampleRate,
      baseLatency: realtime ? ctx.baseLatency : 0,
      outputLatency: realtime ? ctx.outputLatency || 0 : 0,
      lookahead: this.transport.lookahead,
      lateEvents: this.transport.lateEvents,
      faults: this.faults,
    };
  }

  /** Seconds of tail to add after the last note when exporting (release + effect tails). */
  tailSeconds(): number {
    let tail = 0.5;
    for (const s of this.strips.values()) tail = Math.max(tail, s.tailTime);
    let inserts = 0;
    for (const [id, s] of this.inserts) if (id !== MASTER) inserts = Math.max(inserts, s.tailTime);
    return Math.min(30, tail + inserts + this.master.tailTime);
  }

  /** Seconds per bar at the current tempo (export/test helper). */
  barSeconds(): number {
    const p = this.project;
    if (!p) return 0;
    return ticksPerBar(p.transport.timeSig) * (60 / (p.transport.bpm * PPQ));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async dispose(): Promise<void> {
    this.transport.stop();
    this.clock?.terminate();
    this.clock = null;
    for (const s of this.strips.values()) s.dispose();
    this.strips.clear();
    for (const s of this.inserts.values()) s.dispose();
    this.inserts.clear();
    for (const node of this.insertInputs.values()) node.disconnect();
    this.insertInputs.clear();
    for (const p of [...this.ports]) p.dispose();
    this.limiter?.port.postMessage({ t: 'dispose' });
    this.listeners.clear();
    if (typeof AudioContext !== 'undefined' && this.ctx instanceof AudioContext && this.ctx.state !== 'closed') {
      await this.ctx.close();
    }
  }
}
