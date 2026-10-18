/**
 * The audio engine: owns the AudioContext (or an OfflineAudioContext for export), mirrors the
 * project document into a Web Audio graph and drives the lookahead transport.
 */
import { AudibleClock } from './audible-clock';
import type { DocChange } from '@core/history/history';
import type {
  ChannelId,
  InsertId,
  PluginInstance,
  PluginOwner,
  Project,
  SampleId,
  SampleRef,
  Tick,
} from '@core/model/types';
import { effectivelyMuted } from '@core/query/queries';
import { tempoMapOf } from '@core/automation/tempo';
import { automatedOwners } from '@core/automation/owners';
import { playbackKey } from '@core/audio/playback';
import { PPQ, constantTempo, ticksPerBar, type TempoMap } from '@core/time/ppq';
import type { AudioTap, JsonValue, ParamSpecs, TransportInfo } from '@agstudio/sdk';
import { INACTIVE_TAP, TapImpl } from './tap';
import type {
  DeckHost,
  EngineApi,
  EngineOptions,
  EngineSession,
  EngineState,
  EngineStats,
  PluginResolver,
  SampleData,
  TransportView,
} from './api';
import { AutomationDriver } from './automation/driver';
import { ChannelStrip } from './channel-strip';
import type { EngineCore } from './engine-core';
import { NoteFeedHub } from './note-feed';
import { KernelTransportFeed } from './kernel-transport';
import { Metronome } from './metronome';
import { MixerGraph } from './mixer-graph';
import { ParamRegistry } from './param-lane';
import { SampleCache } from './samples';
import { decodeAudio } from './decode';
import { sha256Hex } from '@core/io/hash';
import type { Waveform } from './waveform';
import { SampleResidency } from './sample-residency';
import { startRecording, type RecordOptions, type RecordingHandle } from './recorder';
import { openAudioInput, type AudioInput } from './audio-input';
import type { Timeline } from './sched/core';
import { patternModeSource, songModeSource, type EventSource } from './sched/events';
import { Transport, type TransportSink } from './sched/transport';
import type { LaunchClock, LaunchDriver, LaunchRun } from '@core/launcher/run';
import { LIMITER_ID } from './limiter-id';
import type { WorkletPortImpl } from './worklet-port';
import limiterUrl from './limiter.worklet.ts?worker&url';

const PREVIEW_ID_BASE = 2 ** 30;

const audioKeys = new WeakMap<Project['channels'], string>();

/** One string for how every audio clip channel plays (see playbackKey), memoized per channels record. */
function audioKeyOf(p: Project): string {
  let key = audioKeys.get(p.channels);
  if (key === undefined) {
    const parts: string[] = [];
    for (const id of p.channelOrder) {
      const ch = p.channels[id];
      if (ch?.kind === 'audioClip') parts.push(`${id}:${playbackKey(ch)}`);
    }
    key = parts.join(',');
    audioKeys.set(p.channels, key);
  }
  return key;
}

/**
 * Tempo as plugins see it: the tempo now, the tempo at a scheduled time (from the transport's
 * planned segments, so tempo automation is followed), and change notifications with the time the
 * new tempo starts at.
 */
class TempoInfo implements TransportInfo {
  readonly ppq = PPQ;
  private fns = new Set<(bpm: number, time: number) => void>();
  /** Seconds per tick → BPM at a context time (set once the transport exists). */
  sptAt: ((time: number) => number) | null = null;
  constructor(
    public bpm: number,
    private readonly clock: { readonly currentTime: number },
  ) {}
  tempoAt(time: number): number {
    const spt = this.sptAt?.(time);
    return spt ? Math.round((60 / (spt * PPQ)) * 1e6) / 1e6 : this.bpm;
  }
  onTempo(cb: (bpm: number, time: number) => void): () => void {
    this.fns.add(cb);
    return () => this.fns.delete(cb);
  }
  setBpm(bpm: number, time = this.clock.currentTime): void {
    if (bpm === this.bpm) return;
    this.bpm = bpm;
    for (const fn of this.fns) fn(bpm, time);
  }
}

/** The live worklet ports; a new one is told where the song is right away. */
class PortSet extends Set<WorkletPortImpl> {
  onAdd: ((port: WorkletPortImpl) => void) | null = null;
  override add(port: WorkletPortImpl): this {
    super.add(port);
    this.onAdd?.(port);
    return this;
  }
}

/** How far past the output's last timestamp the heard time may run on the wall clock (seconds). */
const MAX_EXTRAPOLATION = 0.1;
/** Seconds a replaced engine takes to fade out. */
const DISPOSE_FADE = 0.012;
/** How long (ms) one reading of the output clock answers every reader (a frame is 16 ms). */
const AUDIBLE_CACHE_MS = 2;
/** The most the start lead learns to add after late starts (seconds). */
const MAX_START_PAD = 0.03;

export class Engine implements EngineApi, EngineCore {
  readonly ctx: BaseAudioContext;
  readonly plugins: PluginResolver;
  readonly samples: SampleCache;
  readonly residency: SampleResidency;
  readonly offline: boolean;
  readonly transportInfo: TempoInfo;
  readonly params = new ParamRegistry();
  private readonly automation: AutomationDriver;
  private session: EngineSession = { metronome: false, countInBars: 0 };
  /** Post-master bus: master insert + previews → safety limiter → destination. */
  private readonly masterOut: GainNode;
  private readonly previewBus: GainNode;
  /** Metronome and count-in clicks: after the master track, before the limiter; never exported. */
  private readonly monitorBus: GainNode;
  private readonly metronome: Metronome | null;
  /** Inserts, routes, sidechains and delay compensation (engine/mixer-graph.ts). */
  readonly mixer: MixerGraph;
  private readonly strips = new Map<ChannelId, ChannelStrip>();
  private project: Project | null = null;
  private view: TransportView = { mode: 'pattern', patternId: null, loop: null };
  private readonly transport: Transport;
  /** The clip launcher: decides what plays on top of the song (see core/launcher). */
  private launcher: LaunchDriver | null = null;
  /** The runs the transport was last given. */
  private launchSeen: readonly LaunchRun[] | null = null;
  /** The launcher plays on its own (the song is not playing): the transport runs for it alone. */
  private soloLauncher = false;
  private clock: Worker | null = null;
  private readonly listeners = new Set<() => void>();
  private previewSeq = PREVIEW_ID_BASE;
  private previewSource: AudioBufferSourceNode | null = null;
  private previewToken = 0;
  private previewRelease: (() => void) | null = null;
  private readonly waveformsLoading = new Set<string>();
  private faults = 0;
  private muteKey = '';
  /** How every audio clip channel plays its sample (playing clips restart when it changes). */
  private audioKey = '';
  private lastLate = 0;
  private readonly modules = new Map<string, Promise<void>>();
  readonly ports = new PortSet();
  /** Notes of instrument channels for effects that follow a melody (host.notes). */
  readonly noteFeed = new NoteFeedHub();
  private readonly initDone: Promise<void>;
  private limiter: AudioWorkletNode | null = null;
  /** Scheduler cadence (see EngineStats.maxPumpGapMs). */
  private lastPumpAt = 0;
  private maxPumpGap = 0;
  /** Live inputs (closed with the engine). */
  private readonly inputs = new Set<AudioInput>();
  /** Song mode without a loop region plays past the end (recording) instead of looping. */
  private openEnded = false;
  private testClick: AudioBuffer | null = null;
  /** Song mode position the residency plans around while stopped (where playback last started). */
  private songPos = 0;
  private lastSweep = 0;
  private disposed = false;
  /** The constructor has run to its end (the mixer reports its compensation while the engine is being built). */
  private built = false;
  /** Inside reconcile(): a change of the compensation is applied at its end, once the strips are up to date. */
  private reconciling = 0;
  private realign = false;
  /** A channel's shift changed during this reconcile (a re-plan follows while playing). */
  private shiftsMoved = false;
  /**
   * The shift (seconds) each song note was dispatched with, until its release: a note's release, or its cancellation
   * by a re-plan, must carry the shift its start did even if the compensation changed meanwhile (a release earlier
   * than the start cancels the note; later, it would sound for the difference).
   */
  private readonly noteShifts = new Map<number, number>();

  constructor(
    ctx: BaseAudioContext,
    private readonly opts: EngineOptions,
    offline = false,
    /** Offline renders may leave out the master safety limiter (renders that become clips again). */
    private readonly build: { limiter?: boolean } = {},
  ) {
    this.ctx = ctx;
    this.offline = offline;
    this.plugins = opts.plugins;
    this.samples = opts.sampleCache ?? new SampleCache(opts.samples);
    this.residency = new SampleResidency({
      cache: this.samples,
      ctx,
      offline,
      onReady: (ids) => {
        for (const id of ids) this.strips.get(id)?.buffersChanged();
      },
      onStretching: () => this.emit(),
    });
    this.transportInfo = new TempoInfo(130, ctx);
    this.masterOut = new GainNode(ctx);
    this.previewBus = new GainNode(ctx, { gain: 0.8 });
    this.masterOut.connect(ctx.destination);
    this.previewBus.connect(this.masterOut);
    this.monitorBus = new GainNode(ctx, { gain: 0.9 });
    this.monitorBus.connect(this.masterOut);
    this.mixer = new MixerGraph(
      this,
      this.masterOut,
      () => this.emit(),
      () => this.alignChannels(),
    );

    // The song's events reach a channel `shift` seconds late (the mixer's delay compensation is done in time: see
    // ChannelStrip.shift); previews and live input go to the strips directly and are never held back.
    const sink: TransportSink = {
      noteOn: (cid, e) => {
        this.noteFeed.emit(cid, { kind: 'on', time: e.time, noteId: e.noteId, key: e.key, velocity: e.velocity });
        const strip = this.strips.get(cid);
        if (!strip) return;
        const shift = strip.shift;
        if (shift === 0) return strip.noteOn(e);
        this.noteShifts.set(e.noteId, shift);
        strip.noteOn({ ...e, time: e.time + shift });
      },
      audioOn: (cid, e) => {
        const strip = this.strips.get(cid);
        if (!strip) return;
        const shift = strip.shift;
        if (shift === 0) return strip.audioOn(e);
        this.noteShifts.set(e.noteId, shift);
        strip.audioOn({ ...e, time: e.time + shift });
      },
      noteOff: (cid, e) => {
        this.noteFeed.emit(cid, { kind: 'off', time: e.time, noteId: e.noteId, key: e.key, velocity: e.release ?? 0.5 });
        const shift = this.noteShifts.get(e.noteId);
        if (shift === undefined) return this.strips.get(cid)?.noteOff(e);
        this.noteShifts.delete(e.noteId);
        this.strips.get(cid)?.noteOff({ ...e, time: e.time + shift });
      },
      allNotesOff: (time) => {
        this.noteFeed.emitAllOff(time);
        // Everything not yet started goes, whatever shift it has (they are all at or after `time`).
        this.noteShifts.clear();
        for (const s of this.strips.values()) s.allNotesOff(time);
      },
    };
    const empty: EventSource = { project: null as unknown as Project, clips: [] };
    this.transport = new Transport(ctx, sink, empty, {
      tempo: constantTempo(130),
      loop: { start: 0, end: 1 },
      endTick: 1,
    });
    this.transport.onEnded = () => this.emit();
    this.transportInfo.sptAt = (time) => this.transport.sptAt(time);
    this.automation = new AutomationDriver({
      ctx,
      params: this.params,
      offline,
      specsOf: (pluginId) => this.plugins.get(pluginId)?.params as ParamSpecs | undefined,
      timeline: () => this.transport.currentTimeline,
    });
    this.transport.observe(this.automation);
    this.metronome = offline
      ? null
      : new Metronome(
          ctx,
          this.monitorBus,
          () => (this.project ? { tempo: this.tempoMap(), timeSig: this.project.transport.timeSig } : null),
          () => this.mixer.latency,
        );
    if (this.metronome) this.transport.observe(this.metronome);
    // Worklet kernels' view of the song (tempo-synced effects and instruments).
    const kernelTransport = new KernelTransportFeed({
      ports: this.ports,
      tickAt: (time) => this.transport.tickAt(time),
      baseBpm: () => this.transportInfo.bpm,
      now: () => this.ctx.currentTime,
    });
    this.transport.observe(kernelTransport);
    this.transportInfo.onTempo((bpm, time) => kernelTransport.tempoChanged(bpm, time));
    this.ports.onAdd = (port) => kernelTransport.adopt(port);
    // Tempo automation: tell tempo-synced plugins when the tempo of the planned segments changes.
    let lastSpt = 0;
    this.transport.observe({
      started: () => {
        lastSpt = 0;
      },
      segment: (seg) => {
        if (seg.spt !== lastSpt) {
          if (lastSpt !== 0) this.transportInfo.setBpm(Math.round((60 / (seg.spt * PPQ)) * 1e6) / 1e6, seg.time0);
          lastSpt = seg.spt;
        }
      },
      stopped: (time) => {
        if (this.project) this.transportInfo.setBpm(this.project.transport.bpm, time);
      },
    });

    if (!offline && typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
      ctx.addEventListener('statechange', () => this.emit());
    }
    this.built = true;
    this.initDone = this.init();
  }

  /** Where a channel routed to `id` is held back (seconds): see MixerGraph.shiftSeconds. */
  channelShift(id: InsertId): number {
    return this.mixer.shiftSeconds(id);
  }

  /**
   * The mixer's delay compensation was recomputed: every channel (and its automation and plugin anchors) is scheduled
   * later by what its insert is held back. While playing, what was already handed to the audio thread with the old
   * shift is planned again.
   */
  private alignChannels(): void {
    if (!this.built || this.disposed) return;
    if (this.reconciling > 0) {
      this.realign = true;
      return;
    }
    if (this.applyAlignment() && this.transport.playing) this.updateModel();
  }

  /** Returns whether any channel's shift changed. */
  private applyAlignment(): boolean {
    let moved = false;
    for (const strip of this.strips.values()) if (strip.setShift(this.mixer.shiftSeconds(strip.outputId))) moved = true;
    // Insert and effect lanes were moved by the mixer itself; either way the driver plans the moved lanes again.
    this.automation.retime();
    return moved;
  }

  /** Inserts the master safety limiter once its worklet module has loaded. */
  private async init(): Promise<void> {
    if (this.build.limiter === false) return;
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
    this.mixer.pluginsChanged(set, this.project);
  }

  /**
   * A realtime engine with its own AudioContext. A bigger `latencyHint` gives the audio thread more
   * room before it runs dry (busy songs play without crackles) at the cost of a later response.
   */
  static realtime(opts: EngineOptions, latencyHint: AudioContextLatencyCategory | number = 'interactive'): Engine {
    return new Engine(new AudioContext({ latencyHint }), opts, false);
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

  /** Resolves when the master chain and every plugin instance have loaded (not the audio clips' samples). */
  async pluginsReady(): Promise<void> {
    await this.initDone;
    await Promise.all([...[...this.strips.values()].map((s) => s.ready), this.mixer.ready]);
  }

  /**
   * Resolves once the length of every sample in a plugin's slot is known (`host.samples.durationSec`), so a plugin's
   * `tailTime` can depend on its samples. Reads file headers (a decode only for a file they don't describe) and skips
   * what the project already records, so it is cheap. The export's tail probe waits for it after `pluginsReady`.
   */
  async sampleLengthsReady(): Promise<void> {
    const p = this.project;
    if (!p) return;
    const ids = new Set<SampleId>();
    const add = (inst: PluginInstance) => {
      for (const id of Object.values(inst.samples ?? {})) if (id) ids.add(id);
    };
    for (const ch of Object.values(p.channels)) if (ch.kind === 'instrument') add(ch.plugin);
    for (const ins of Object.values(p.mixer.inserts)) for (const slot of ins.fx) add(slot.plugin);
    await Promise.all(
      [...ids].map((id) => {
        const ref = p.samples[id];
        return ref ? this.samples.learnDuration(ref, this.ctx).catch(() => null) : null;
      }),
    );
  }

  /** Resolves when the master chain and every plugin instance (instruments and effects) have loaded. */
  async ready(): Promise<void> {
    await this.initDone;
    await Promise.all([...[...this.strips.values()].map((s) => s.ready), this.mixer.ready, this.residency.settled()]);
  }

  // ---- Document mirroring ----

  applyDocChange(change: DocChange): void {
    const prev = change.origin === 'load' ? null : this.project;
    this.reconcile(prev, change.next);
  }

  private reconcile(prev: Project | null, next: Project): void {
    if (prev === next) return;
    this.reconciling++;
    this.shiftsMoved = false;
    try {
      this.reconcileInto(prev, next);
    } finally {
      this.reconciling--;
    }
    if (this.realign) {
      this.realign = false;
      if (this.applyAlignment()) this.shiftsMoved = true;
    }
    // Scheduling changes were re-planned at the end of reconcileInto; a moved shift needs a re-plan of its own.
    if (this.shiftsMoved && this.transport.playing) this.updateModel();
    this.shiftsMoved = false;
  }

  private reconcileInto(prev: Project | null, next: Project): void {
    this.project = next;
    if (!prev || prev.transport.bpm !== next.transport.bpm) this.transportInfo.setBpm(next.transport.bpm);

    // Inserts first (channels connect to them), removals last.
    const removedInserts = this.mixer.reconcile(prev, next);

    if (!prev || prev.channels !== next.channels || prev.samples !== next.samples) {
      const muted = effectivelyMuted(next.channels);
      for (const id of next.channelOrder) {
        const ch = next.channels[id];
        if (!ch || ch.kind === 'automation') continue;
        const strip = this.strips.get(id);
        if (!strip) this.strips.set(id, new ChannelStrip(this, ch, next));
        else {
          const prevCh = prev?.channels[id];
          if (prevCh !== ch) {
            const was = strip.shift;
            strip.update(ch, next);
            if (strip.shift !== was) this.shiftsMoved = true;
          } else if (prev && prev.samples !== next.samples) strip.samplesChanged(next);
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
    this.mixer.removeStrips(removedInserts);
    // First automation on a plugin that ran without AudioParams: it gets them (a new instance).
    if (prev && prev.channels !== next.channels && automatedOwners(prev.channels) !== automatedOwners(next.channels)) {
      for (const strip of this.strips.values()) strip.automationChanged(next);
      this.mixer.automationChanged(next);
    }

    if (!prev || prev.channels !== next.channels || prev.channelOrder !== next.channelOrder) this.noteFeed.setProject(next);
    const muteKey = [...effectivelyMuted(next.channels)].sort().join(',');
    const audioKey = !prev || prev.channels !== next.channels ? audioKeyOf(next) : this.audioKey;
    const schedulingChanged =
      !prev ||
      prev.patterns !== next.patterns ||
      prev.playlist !== next.playlist ||
      prev.transport !== next.transport ||
      prev.channelOrder !== next.channelOrder ||
      muteKey !== this.muteKey ||
      audioKey !== this.audioKey;
    this.muteKey = muteKey;
    this.audioKey = audioKey;
    if (
      !prev ||
      prev.playlist !== next.playlist ||
      prev.channels !== next.channels ||
      prev.transport !== next.transport ||
      prev.samples !== next.samples
    )
      this.residency.setProject(next);
    // Automation first: a re-planning transport then schedules segments with the new curves.
    this.automation.update(next, this.view);
    if (schedulingChanged) this.updateModel();
  }

  /** True while a time-stretched copy of the channel's sample is being computed. */
  isStretching(channelId: ChannelId): boolean {
    return this.residency.isStretching(channelId);
  }

  notify(): void {
    this.emit();
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
    if (this.project) this.automation.update(this.project, view);
    this.updateModel();
  }

  private model(): { source: EventSource; timeline: Timeline } | null {
    const p = this.project;
    if (!p) return null;
    const launch = this.launcher ? { launch: { runs: this.launcher.runs } } : {};
    if (this.soloLauncher) {
      // The launcher on its own: no song, the project's tempo, until something stops it.
      const tempo = tempoMapOf(p, 'pattern');
      return {
        source: { project: p, clips: [], ...launch },
        timeline: { tempo, loop: null, endTick: Number.MAX_SAFE_INTEGER },
      };
    }
    const m = this.songModel(p);
    return { source: { ...m.source, ...launch }, timeline: m.timeline };
  }

  private songModel(p: Project): { source: EventSource; timeline: Timeline } {
    const tempo = tempoMapOf(p, this.view.mode);
    if (this.view.mode === 'song') {
      // Song mode loops the loop region, or the whole song (FL's default); while recording audio
      // without a loop region it plays on past the end.
      const { source, length } = songModeSource(p);
      const songEnd = Math.max(length, ticksPerBar(p.transport.timeSig));
      const region = this.view.loop && this.view.loop.end > this.view.loop.start ? this.view.loop : null;
      if (!region && this.openEnded) return { source, timeline: { tempo, loop: null, endTick: Number.MAX_SAFE_INTEGER } };
      return { source, timeline: { tempo, loop: region ?? { start: 0, end: songEnd }, endTick: songEnd } };
    }
    const { source, length } = patternModeSource(p, this.view.patternId ?? p.patternOrder[0] ?? null);
    return { source, timeline: { tempo, loop: { start: 0, end: length }, endTick: length } };
  }

  /** The tempo map playback uses now (song mode follows tempo automation). */
  tempoMap(): TempoMap {
    return this.project ? tempoMapOf(this.project, this.view.mode) : constantTempo(this.transportInfo.bpm);
  }

  private updateModel(): void {
    const m = this.model();
    if (m) this.transport.setModel(m.source, m.timeline);
    this.updateResidency(true);
  }

  // ---- The clip launcher ----

  /** Hands over what decides what the launcher plays (null lets go). The engine reads its runs on every scheduler tick. */
  setLauncher(driver: LaunchDriver | null): void {
    this.launcher = driver;
    this.launchSeen = driver ? driver.runs : null;
    if (!driver) this.soloLauncher = false;
    this.updateModel();
  }

  /**
   * Where the transport is on the launcher axis: what is heard now and the earliest tick a launch can still be
   * scheduled at (after the time the first notes need to reach the audio thread). Not playing: all zero.
   */
  launcherClock(): LaunchClock {
    if (!this.transport.playing) return { playing: false, heardU: 0, earliestU: 0 };
    const now = this.ctx.currentTime;
    return {
      playing: true,
      heardU: this.transport.uAtTime(this.heardTime()),
      earliestU: this.transport.uAtTime(now + Math.max(0.015, this.startLead())),
    };
  }

  /**
   * The launcher's runs changed (a press): plays them. While nothing plays, the transport starts for the launcher
   * alone, from tick 0 with the first run starting right there.
   */
  launcherChanged(): void {
    const d = this.launcher;
    if (!d || !this.project) return;
    if (!this.transport.playing) {
      if (d.runs.length === 0) return;
      this.soloLauncher = true;
      this.launchSeen = d.runs;
      void this.resume();
      this.warmLaunchAudio(d.runs);
      this.updateModel();
      this.maxPumpGap = 0;
      this.transport.start(0, this.ctx.currentTime + this.startLead());
      this.startClock();
      this.emit();
      return;
    }
    this.syncLauncher();
  }

  /** Follow actions, ended runs; new runs are planned. Called on every scheduler tick. */
  private syncLauncher(): void {
    const d = this.launcher;
    if (!d || !this.transport.playing) return;
    const clock = this.launcherClock();
    d.advance(clock);
    if (d.runs !== this.launchSeen) {
      this.launchSeen = d.runs;
      this.warmLaunchAudio(d.runs);
      this.updateModel();
    }
    // The launcher alone stops with its last run.
    if (this.soloLauncher && d.runs.length > 0 && d.idleAt(clock.heardU)) this.stop();
  }

  /** Audio runs: their samples are decoded before the first pass (the playlist's residency does not know them). */
  private warmLaunchAudio(runs: readonly LaunchRun[]): void {
    for (const r of runs) if (r.content.kind === 'audio') this.strips.get(r.content.channelId)?.warm();
  }

  /**
   * Tells the residency where the song is (what to keep decoded): the heard position while song
   * mode plays, else where song playback last started. Called on every scheduler tick (cheap: it
   * plans again only when the position moved by a second or the song changed).
   */
  private updateResidency(force = false): void {
    if (this.offline || this.disposed) return;
    const playingSong = this.transport.playing && this.view.mode === 'song';
    if (playingSong) this.songPos = this.transport.positionAt(this.heardTime());
    const loop = this.view.mode === 'song' && !this.openEnded ? this.transport.currentTimeline.loop : null;
    this.residency.setPosition(this.songPos, loop, playingSong);
    // Finished voices let go of their buffers (twice a second is plenty).
    const now = this.ctx.currentTime;
    if (force || now - this.lastSweep > 0.5) {
      this.lastSweep = now;
      for (const s of this.strips.values()) s.sweep();
    }
  }

  /**
   * Offline renders: everything the clips scheduled up to `horizon` (context time) play from is
   * decoded (and stretched) before they are scheduled, so a render never depends on timing.
   */
  async prepareOffline(horizon: number): Promise<void> {
    // Finished voices let go of their buffers (so what the render has passed can be evicted).
    for (const s of this.strips.values()) s.sweep();
    if (this.view.mode !== 'song') return;
    const a = this.transport.tickAt(this.ctx.currentTime).tick;
    const b = this.transport.tickAt(horizon).tick;
    await this.residency.ensure(a, b);
  }

  /** Offline renders: like prepareOffline, for song ticks [fromTick, toTick] (before the transport starts). */
  async prepareTicks(fromTick: number, toTick: number): Promise<void> {
    if (this.view.mode !== 'song') return;
    await this.residency.ensure(fromTick, toTick);
  }

  // ---- EngineCore ----

  /** Where a channel routed to `id` connects (unknown inserts play through the master). */
  insertInput(id: InsertId): AudioNode {
    return this.mixer.insertInput(id);
  }

  requestState(owner: PluginOwner, state: JsonValue): void {
    this.opts.onPluginStateRequest?.(owner, state);
  }

  reportFault(owner: PluginOwner, pluginId: string, err: unknown): void {
    this.faults++;
    this.opts.onPluginFault?.(owner, pluginId, err);
    this.emit();
  }

  reportTap(owner: PluginOwner, tap: AudioTap, live: boolean): void {
    this.opts.onPluginTap?.(owner, tap, live);
  }

  // ---- Transport ----

  play(fromTick = 0): void {
    if (!this.project) return;
    void this.resume();
    // The launcher alone gives way to the song (its runs go on, over the song).
    this.soloLauncher = false;
    this.updateModel();
    // Playing again while playing is a seek: what was scheduled is cancelled or released first.
    const lateBefore = this.transport.lateEvents;
    const at = this.ctx.currentTime + this.startLead();
    if (this.view.mode === 'song') {
      this.songPos = fromTick;
      this.residency.setPosition(fromTick, this.transport.currentTimeline.loop, true);
    }
    if (this.transport.playing) this.transport.seek(fromTick, at);
    else {
      this.maxPumpGap = 0;
      // Count-in (record mode): clicks first, then playback.
      const countIn =
        this.metronome && this.session.countInBars > 0
          ? this.metronome.countIn(
              at,
              this.session.countInBars,
              this.tempoMap().bpmAt(fromTick),
              this.project.transport.timeSig,
            )
          : 0;
      this.transport.start(fromTick, at + countIn);
    }
    // The first notes went out late (a busy main thread): leave more room next time.
    if (this.transport.lateEvents > lateBefore) this.startPad = Math.min(MAX_START_PAD, this.startPad + 0.01);
    this.startClock();
    this.emit();
  }

  /**
   * Seconds between pressing play (or seeking) and the first beat. The first notes reach the audio thread by message,
   * which handles them within about one audio callback (`baseLatency`) plus a render quantum; anything earlier is
   * wasted waiting. Measured with the output probe in test/browser/latency.test.ts: 14 / 21 / 38 ms for the small,
   * medium and large buffer, where the fixed 50 ms it replaced added a third to a half of the response. `startPad`
   * grows by 10 ms (to 30) every time notes still went out late, and stays.
   */
  private startLead(): number {
    const ctx = this.ctx;
    const base = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext ? ctx.baseLatency : 0.01;
    return Math.min(0.05, Math.max(0.012, 0.006 + 1.5 * base + this.startPad));
  }

  /** Extra start lead learned from late starts (seconds). */
  private startPad = 0;

  stop(): void {
    this.transport.stop(0);
    this.soloLauncher = false;
    this.launcher?.reset?.();
    this.launchSeen = this.launcher ? this.launcher.runs : null;
    this.stopClock();
    // Stopped: the residency lets its pins go, and the voices' buffers once their release is over.
    this.updateResidency(true);
    if (!this.offline) setTimeout(() => this.updateResidency(true), 300);
    this.emit();
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    const ctx = this.ctx as BaseAudioContext & { setSinkId?(id: string): Promise<void> };
    if (this.offline || typeof ctx.setSinkId !== 'function') return false;
    try {
      await ctx.setSinkId(deviceId);
      return true;
    } catch {
      return false;
    }
  }

  panic(): void {
    this.stop();
    const now = this.ctx.currentTime;
    for (const s of this.strips.values()) s.allNotesOff(now, true);
    for (const port of this.ports) port.reset();
    // Graph effects can't be flushed: duck the output while their tails ring out.
    const g = this.masterOut.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.01);
    g.setValueAtTime(0, now + 0.6);
    g.linearRampToValueAtTime(1, now + 0.65);
  }

  /** Offline rendering: start the transport on the virtual clock (call pumpOffline per chunk). */
  startOffline(fromTick: number, at: number): void {
    this.updateModel();
    this.transport.start(fromTick, at);
  }

  pumpOffline(horizon: number): void {
    this.syncLauncher();
    this.transport.pump(horizon);
  }

  /** Offline rendering: the music ends at `time` (context seconds): notes still held are released there. */
  endOffline(time: number): void {
    this.transport.releaseHeld(time);
  }

  playhead(): number {
    return this.transport.positionAt(this.heardTime());
  }

  playheadIteration(): number {
    return this.transport.iterationAt(this.heardTime());
  }

  /**
   * The scheduling time of what is being heard: the audible time minus the mixer's latency (delay
   * compensation holds every path back to the longest one, so music scheduled at t is heard at
   * t + graphLatency).
   */
  private heardTime(): number {
    return this.audibleTime() - this.mixer.latency;
  }

  /** The heard time, smoothed so the playhead moves evenly (and never back): see audible-clock.ts. */
  private readonly audible = new AudibleClock();

  /**
   * Context time currently coming out of the speakers: the output's last timestamp, carried on by
   * the wall clock for at most `MAX_EXTRAPOLATION` (when the audio thread falls behind, its clock
   * stalls; running on past it and snapping back made the playhead jump back and forth), then smoothed
   * and kept from going back (`AudibleClock`).
   */
  private audibleTime(): number {
    const ctx = this.ctx;
    if (typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
      // Everything that reads it within a frame (playhead, step lights, automation, tempo readouts: several per
      // frame) gets one answer: a clock read allocates a timestamp object, and readers must agree on the time.
      const nowMs = performance.now();
      if (nowMs - this.audibleAt < AUDIBLE_CACHE_MS && nowMs >= this.audibleAt) return this.audibleValue;
      const ts = ctx.getOutputTimestamp();
      let t: number;
      if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
        const ahead = Math.max(0, Math.min(MAX_EXTRAPOLATION, (performance.now() - ts.performanceTime) / 1000));
        t = ts.contextTime + ahead;
      } else t = ctx.currentTime - (ctx.outputLatency || 0) - ctx.baseLatency;
      this.audibleAt = nowMs;
      return (this.audibleValue = this.audible.step(t, nowMs));
    }
    return ctx.currentTime;
  }

  /** The last answer of audibleTime() and the `performance.now()` it was read at. */
  private audibleAt = Number.NEGATIVE_INFINITY;
  private audibleValue = 0;

  private startClock(): void {
    if (this.offline) return;
    this.lastPumpAt = 0;
    this.keepUpFrom = null;
    this.keepUp = undefined;
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
    const now = performance.now();
    if (wasPlaying && this.lastPumpAt > 0) this.maxPumpGap = Math.max(this.maxPumpGap, now - this.lastPumpAt);
    this.lastPumpAt = now;
    if (wasPlaying) this.measureKeepUp(now);
    this.syncLauncher();
    this.transport.pump();
    this.updateResidency();
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

  /** The audio clock against the wall clock, per second of playback (`stats().keepUp`). */
  private keepUpFrom: { wall: number; ctx: number } | null = null;
  private keepUp: number | undefined;

  private measureKeepUp(now: number): void {
    const t = this.ctx.currentTime;
    const from = this.keepUpFrom;
    if (!from) {
      this.keepUpFrom = { wall: now, ctx: t };
      return;
    }
    const wall = (now - from.wall) / 1000;
    if (wall < 1) return;
    this.keepUp = Math.min(1, (t - from.ctx) / wall);
    this.keepUpFrom = { wall: now, ctx: t };
  }

  // ---- Previews ----

  previewNoteOn(channelId: ChannelId, key: number, velocity = 0.8): number {
    void this.resume();
    const noteId = ++this.previewSeq;
    const time = this.ctx.currentTime;
    this.previewOn.set(noteId, time);
    this.noteFeed.emit(channelId, { kind: 'on', time, noteId, key, velocity });
    this.strips.get(channelId)?.noteOn({ time, noteId, key, velocity });
    return noteId;
  }

  previewNoteOff(channelId: ChannelId, noteId: number): void {
    // A quick tap: `currentTime` only moves once per audio callback (21 ms with the large buffer), so the release
    // could carry the very time of the press and cancel the note (a release at or before its start). Hold it back
    // until the sound has started: a callback and a bit after the press.
    const on = this.previewOn.get(noteId);
    this.previewOn.delete(noteId);
    const now = this.ctx.currentTime;
    const time = on === undefined ? now : Math.max(now, on + this.previewHold());
    this.noteFeed.emit(channelId, { kind: 'off', time, noteId, key: 0, velocity: 0.5 });
    this.strips.get(channelId)?.noteOff({ time, noteId, key: 0 });
  }

  /** Press time of each live note until its release. */
  private readonly previewOn = new Map<number, number>();

  private previewHold(): number {
    const ctx = this.ctx;
    const base = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext ? ctx.baseLatency : 0.01;
    return Math.max(0.01, 2.5 * base);
  }

  previewControl(channelId: ChannelId, cc: number, value: number): void {
    this.strips.get(channelId)?.controlChange(cc, value, this.ctx.currentTime);
  }

  previewPitchBend(channelId: ChannelId, cents: number): void {
    this.strips.get(channelId)?.setBend(cents, this.ctx.currentTime);
  }

  previewSample(ref: Pick<SampleRef, 'source' | 'name'>): void {
    void this.resume();
    void this.samples.load(ref, this.ctx).then((buffer) => {
      if (buffer) this.playPreview(buffer, SampleCache.keyOf(ref.source, this.ctx.sampleRate));
    });
  }

  async record(
    stream: MediaStream,
    opts: RecordOptions & { playAlong: boolean; fromTick?: Tick },
  ): Promise<RecordingHandle> {
    const ctx = this.ctx;
    if (typeof AudioContext === 'undefined' || !(ctx instanceof AudioContext))
      throw new Error('Recording needs the realtime engine.');
    await this.resume();
    this.stop();
    // Count in at the tempo where playback starts (tempo automation can change it later).
    const bpm = this.project ? this.tempoMap().bpmAt(opts.fromTick ?? 0) : opts.bpm;
    const handle = await startRecording(
      ctx,
      (url) => this.loadModule(url),
      stream,
      { ...opts, bpm: opts.playAlong ? bpm : opts.bpm },
      this.previewBus,
    );
    if (opts.playAlong && this.project) {
      this.updateModel();
      this.transport.start(opts.fromTick ?? 0, handle.barOneTime);
      this.startClock();
      this.emit();
      handle.done.then(
        () => this.stop(),
        () => this.stop(),
      );
    }
    return handle;
  }

  async openAudioInput(
    stream: MediaStream,
    opts: { channels: 1 | 2; label?: string; latency?: number },
  ): Promise<AudioInput> {
    const ctx = this.ctx;
    if (typeof AudioContext === 'undefined' || !(ctx instanceof AudioContext))
      throw new Error('Recording needs the realtime engine.');
    await this.resume();
    const input = await openAudioInput(
      ctx,
      {
        loadModule: (url) => this.loadModule(url),
        insertInput: (id) => this.insertInput(id),
        // Output latency plus the master limiter's look-ahead (music and clicks pass through it).
        outputLatency: () => ctx.baseLatency + (ctx.outputLatency || 0) + Math.round(0.0013 * ctx.sampleRate) / ctx.sampleRate,
      },
      stream,
      opts,
    );
    const close = input.close.bind(input);
    input.close = () => {
      this.inputs.delete(input);
      close();
    };
    this.inputs.add(input);
    return input;
  }

  playTestClicks(count: number, interval: number): number[] {
    const ctx = this.ctx;
    if (!this.testClick) {
      const n = Math.round(0.004 * ctx.sampleRate);
      const b = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: ctx.sampleRate });
      const d = b.getChannelData(0);
      // A sharp, loud-ish tick: easy to find in a recording.
      for (let i = 0; i < n; i++) d[i] = 0.8 * Math.sin((2 * Math.PI * 2000 * i) / ctx.sampleRate) * Math.exp(-i / (0.001 * ctx.sampleRate));
      this.testClick = b;
    }
    const t0 = ctx.currentTime + 0.3;
    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      const at = t0 + i * interval;
      const src = new AudioBufferSourceNode(ctx, { buffer: this.testClick });
      src.connect(this.monitorBus);
      src.onended = () => src.disconnect();
      src.start(at);
      times.push(at);
    }
    return times;
  }

  setSongOpenEnded(on: boolean): void {
    if (on === this.openEnded) return;
    this.openEnded = on;
    this.updateModel();
  }

  waveform(ref: Pick<SampleRef, 'source'>): Waveform | null {
    const w = this.samples.waveform(ref, this.ctx.sampleRate);
    if (w) return w;
    const key = SampleCache.keyOf(ref.source, this.ctx.sampleRate);
    if (!this.waveformsLoading.has(key)) {
      this.waveformsLoading.add(key);
      // A sample that can't be decoded stays in the set: it isn't tried again on every redraw.
      void this.samples.loadWaveform(ref, this.ctx).then((done) => {
        if (!done) return;
        this.waveformsLoading.delete(key);
        this.emit();
      });
    }
    return null;
  }

  async sampleData(ref: Pick<SampleRef, 'source' | 'name'>): Promise<SampleData | null> {
    const buffer = await this.samples.load(ref, this.ctx);
    if (!buffer) return null;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    return { sampleRate: buffer.sampleRate, channels, duration: buffer.duration };
  }

  async previewAudio(bytes: ArrayBuffer): Promise<boolean> {
    void this.resume();
    const token = ++this.previewToken;
    // Decoded once per file content (the shared cache keeps it, within its budget): clicking the
    // same file again in the browser plays at once.
    const key = `p:${await sha256Hex(new Uint8Array(bytes))}:${this.ctx.sampleRate}`;
    const buffer = await this.samples.derive(key, () => decodeAudio(this.ctx, bytes).catch(() => null));
    if (!buffer) return false;
    // A newer preview (or a stop) was requested while this one decoded.
    if (token === this.previewToken) this.playPreview(buffer, key);
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
    this.previewRelease?.();
    this.previewRelease = null;
  }

  /** Plays a buffer on the preview bus; its cache entry stays pinned while it sounds. */
  private playPreview(buffer: AudioBuffer, key: string): void {
    this.stopPreview();
    const src = new AudioBufferSourceNode(this.ctx, { buffer });
    const release = this.samples.pin(key);
    src.connect(this.previewBus);
    src.onended = () => {
      src.disconnect();
      release();
    };
    src.start();
    this.previewSource = src;
    this.previewRelease = release;
  }

  // ---- Meters ----

  readMeters(order: readonly InsertId[], out: Float32Array): void {
    this.mixer.readMeters(order, out);
  }

  // ---- Timeline, automation, session ----

  tickAt(contextTime: number): { tick: number; iter: number } {
    // What is heard at t was scheduled at t − latency (delay compensation holds the music back).
    return this.transport.tickAt(contextTime - this.mixer.latency);
  }

  contextTimeAt(performanceMs: number): number {
    const ctx = this.ctx;
    if (typeof AudioContext !== 'undefined' && ctx instanceof AudioContext) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0)
        return ts.contextTime + (performanceMs - ts.performanceTime) / 1000;
      return ctx.currentTime - (ctx.outputLatency || 0) - ctx.baseLatency + (performanceMs - performance.now()) / 1000;
    }
    return ctx.currentTime;
  }

  readAutomation(keys: readonly string[], out: Float64Array): void {
    const t = this.heardTime();
    for (let i = 0; i < keys.length && i < out.length; i++) out[i] = this.automation.readValue(keys[i] as string, t);
  }

  touch(key: string, on: boolean): void {
    this.automation.touch(key, on);
  }

  tempoNow(): number {
    return this.transportInfo.tempoAt(this.heardTime());
  }

  setSession(session: EngineSession): void {
    this.session = { ...session };
    if (this.metronome) this.metronome.enabled = session.metronome;
  }

  /** Session settings in effect (metronome, count-in). */
  get sessionSettings(): EngineSession {
    return this.session;
  }

  graphLatency(): number {
    return this.mixer.latency;
  }

  private outTap: TapImpl | null = null;
  outputTap(): AudioTap {
    if (this.offline) return INACTIVE_TAP;
    return (this.outTap ??= new TapImpl(this.ctx, this.masterOut, { fftSize: 4096, smoothing: 0.8 }));
  }

  // ---- Status ----

  private host: DeckHost | null = null;
  /** Where the DJ decks join the output (see DeckHost); null for an offline engine. */
  deckHost(): DeckHost | null {
    if (this.offline || typeof AudioContext === 'undefined' || !(this.ctx instanceof AudioContext)) return null;
    return (this.host ??= {
      ctx: this.ctx,
      output: this.masterOut,
      loadModule: (url) => this.loadModule(url),
      heardTime: () => this.audibleTime(),
    });
  }

  stats(): EngineStats {
    const ctx = this.ctx;
    const realtime = typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;
    return {
      state: this.state,
      sampleRate: ctx.sampleRate,
      baseLatency: realtime ? ctx.baseLatency : 0,
      outputLatency: realtime ? ctx.outputLatency || 0 : 0,
      lookahead: this.transport.lookahead,
      startLead: this.startLead(),
      lateEvents: this.transport.lateEvents,
      maxPumpGapMs: Math.round(this.maxPumpGap),
      faults: this.faults,
      ...(this.keepUp !== undefined ? { keepUp: this.keepUp } : {}),
    };
  }

  /**
   * Seconds of tail to add after the last note when exporting: the longest instrument release plus
   * the effect tails along the deepest route path (capped at 30 s), plus the mixer's latency.
   */
  tailSeconds(): number {
    let tail = 0.5;
    for (const s of this.strips.values()) tail = Math.max(tail, s.tailTime);
    return Math.min(30, tail + this.mixer.tailSeconds()) + this.mixer.latency;
  }

  /** Seconds of the first bar (export/test helper; later bars can differ with tempo automation). */
  barSeconds(): number {
    const p = this.project;
    if (!p) return 0;
    return this.tempoMap().tickToSeconds(ticksPerBar(p.transport.timeSig));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async dispose(): Promise<void> {
    // A running engine that is replaced (a new buffer size, a rebooted output) fades out first instead of clicking.
    if (!this.offline && typeof AudioContext !== 'undefined' && this.ctx instanceof AudioContext && this.ctx.state === 'running') {
      const g = this.masterOut.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + DISPOSE_FADE);
      if (typeof document === 'undefined' || !document.hidden) await new Promise((r) => setTimeout(r, DISPOSE_FADE * 1000 + 3));
    }
    this.disposed = true;
    this.transport.stop();
    this.automation.dispose();
    this.metronome?.dispose();
    this.clock?.terminate();
    this.clock = null;
    for (const s of this.strips.values()) s.dispose();
    this.strips.clear();
    this.residency.dispose();
    this.mixer.dispose();
    for (const p of [...this.ports]) p.dispose();
    for (const input of [...this.inputs]) input.close();
    this.limiter?.port.postMessage({ t: 'dispose' });
    this.outTap?.dispose();
    this.listeners.clear();
    if (typeof AudioContext !== 'undefined' && this.ctx instanceof AudioContext && this.ctx.state !== 'closed') {
      await this.ctx.close();
    }
  }
}
