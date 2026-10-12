/**
 * The audio engine: owns the AudioContext (or an OfflineAudioContext for export), mirrors the
 * project document into a Web Audio graph and drives the lookahead transport.
 */
import type { DocChange } from '@core/history/history';
import {
  MASTER,
  type ChannelId,
  type InsertId,
  type PluginOwner,
  type Project,
  type SampleRef,
} from '@core/model/types';
import { effectivelyMuted } from '@core/query/queries';
import { PPQ, ticksPerBar } from '@core/time/ppq';
import type { JsonValue, TransportInfo } from '@agstudio/sdk';
import type { EngineApi, EngineOptions, EngineState, EngineStats, PluginResolver, TransportView } from './api';
import { ChannelStrip } from './channel-strip';
import type { EngineCore } from './engine-core';
import { SampleCache } from './samples';
import type { Timeline } from './sched/core';
import { patternModeSource, type EventSource } from './sched/events';
import { Transport, type TransportSink } from './sched/transport';

const PREVIEW_ID_BASE = 2 ** 30;

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
  private readonly masterIn: GainNode;
  private readonly masterOut: GainNode;
  private readonly previewBus: GainNode;
  private readonly strips = new Map<ChannelId, ChannelStrip>();
  private project: Project | null = null;
  private view: TransportView = { mode: 'pattern', patternId: null, loop: null };
  private readonly transport: Transport;
  private clock: Worker | null = null;
  private readonly listeners = new Set<() => void>();
  private previewSeq = PREVIEW_ID_BASE;
  private previewSource: AudioBufferSourceNode | null = null;
  private faults = 0;
  private muteKey = '';
  private lastLate = 0;

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
    this.masterIn = new GainNode(ctx);
    this.masterOut = new GainNode(ctx);
    this.previewBus = new GainNode(ctx, { gain: 0.8 });
    this.masterIn.connect(this.masterOut).connect(ctx.destination);
    this.previewBus.connect(this.masterOut);

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

  /** Resolves when every plugin instance has finished loading. */
  async ready(): Promise<void> {
    await Promise.all([...this.strips.values()].map((s) => s.ready));
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

    if (!prev || prev.channels !== next.channels || prev.samples !== next.samples) {
      const muted = effectivelyMuted(next.channels);
      for (const id of next.channelOrder) {
        const ch = next.channels[id];
        if (!ch || ch.kind !== 'instrument') continue;
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
        if (next.channels[id]?.kind !== 'instrument') {
          strip.dispose();
          this.strips.delete(id);
        }
      }
    }

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
    // Song mode arrives with the playlist (M4); until then both modes loop the current pattern.
    const { source, length } = patternModeSource(p, this.view.patternId ?? p.patternOrder[0] ?? null);
    return { source, timeline: { spt, loop: { start: 0, end: length }, endTick: length } };
  }

  private updateModel(): void {
    const m = this.model();
    if (m) this.transport.setModel(m.source, m.timeline);
  }

  // ---- EngineCore ----

  insertInput(_id: InsertId): AudioNode {
    // Mixer inserts arrive in M5; everything feeds the master until then.
    void MASTER;
    return this.masterIn;
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

  /** Offline rendering: schedule everything up to `until` seconds at once. */
  scheduleOffline(fromTick: number, at: number, until: number): void {
    this.updateModel();
    this.transport.start(fromTick, at);
    this.transport.pump(until);
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
      if (!buffer) return;
      try {
        this.previewSource?.stop();
      } catch {
        /* already stopped */
      }
      const src = new AudioBufferSourceNode(this.ctx, { buffer });
      src.connect(this.previewBus);
      src.onended = () => src.disconnect();
      src.start();
      this.previewSource = src;
    });
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

  /** Seconds of release tail to add after the last note when exporting. */
  tailSeconds(): number {
    let tail = 0.5;
    for (const s of this.strips.values()) tail = Math.max(tail, s.tailTime);
    return Math.min(10, tail);
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
    this.listeners.clear();
    if (typeof AudioContext !== 'undefined' && this.ctx instanceof AudioContext && this.ctx.state !== 'closed') {
      await this.ctx.close();
    }
  }
}
