/**
 * Automation as the app sees it:
 * - "touch": while a knob or fader drag moves an automated target, automation lets go of it (the
 *   drag is heard) and takes over again when the drag ends;
 * - recording: with record mode on, every knob/fader/tempo move during playback is written into an
 *   automation clip for that target (created on demand), thinned to a few points, one undo step per
 *   take;
 * - "Create automation clip" for any automatable target, plain labels and value readouts;
 * - status for controls: which targets are automated (or being recorded), for indicators and hints.
 */
import type { Draft } from 'immer';
import type { DocChange, History } from '@core/history/history';
import { targetsChangedBy } from '@core/automation/changes';
import { mergePasses, spliceCurve, thinSamples, type Sample } from '@core/automation/generate';
import { automationLabel, formatAutomationValue, targetName, type PluginInfoResolver } from '@core/automation/labels';
import { resolveTarget, TEMPO_RANGE, type ResolvedTarget, type SpecsResolver } from '@core/automation/targets';
import { PALETTE } from '@core/model/defaults';
import { targetKey } from '@core/model/targets';
import type { AutomationChannel, ChannelId, ClipId, LaneId, ParamTarget, Project, Tick } from '@core/model/types';
import { mutedLanes } from '@core/query/playlist';
import { createAutomationClip, setAutomationPoints } from '@core/ops/automation';
import { ticksPerBar } from '@core/time/ppq';
import { isAutomatable, type ParamSpecs } from '@agstudio/sdk';
import type { EngineApi } from '@engine/api';
import type { PluginRegistry } from './plugins/registry';
import type { RecordController } from './recording';
import type { DocStore } from './stores/doc';
import type { EditorStore } from './stores/editor';
import type { SessionStore } from './stores/session';
import type { ViewStore } from './stores/view';

export interface AutomationDeps {
  history: History;
  doc: DocStore;
  engine: EngineApi;
  recording: RecordController;
  view: ViewStore;
  editor: EditorStore;
  plugins: PluginRegistry;
  session: SessionStore;
}

/** What a control shows about its target: driven by a clip, or being recorded. */
export interface AutomationStatus {
  kind: 'automated' | 'muted' | 'recording';
  /** For the control's hint, e.g. "Automated by clip ‘Cutoff · 3xOsc’ – right-click to edit". */
  hint: string;
}

interface Recorded {
  target: ParamTarget;
  /** The value before the first move (a new clip holds it until then). */
  before: Sample;
  /** One list per pass through the loop. */
  passes: Sample[][];
  lastIter: number;
  lastTick: number;
}

interface Take {
  /** Keys automation lets go of until the take ends (the recorded value is what's heard). */
  latched: Set<string>;
  recorded: Map<string, Recorded>;
  warned: boolean;
}

/** Recorded moves closer than this (normalized) to a straight line between kept points are dropped. */
const THIN = 0.005;

/** A tempo clip spans 60–180 BPM unless the tempo is outside that range. */
export function tempoRange(bpm: number): { min: number; max: number } {
  return {
    min: bpm < TEMPO_RANGE.min ? Math.max(10, Math.floor(bpm / 10) * 10 - 10) : TEMPO_RANGE.min,
    max: bpm > TEMPO_RANGE.max ? Math.min(522, Math.ceil(bpm / 10) * 10 + 10) : TEMPO_RANGE.max,
  };
}

export class AutomationService {
  /** Targets a drag is moving right now. */
  private readonly dragged = new Set<string>();
  private take: Take | null = null;
  private readonly watchers = new Map<string, Set<(s: AutomationStatus | null) => void>>();
  private readonly shown = new Map<string, string>();
  private index: { channels: object; playlist: object; byKey: Map<string, AutomationChannel[]> } | null = null;

  readonly specsOf: SpecsResolver = (id) => this.s.plugins.get(id)?.params as ParamSpecs | undefined;
  readonly pluginInfo: PluginInfoResolver = (id) => {
    const def = this.s.plugins.get(id);
    return def ? { name: def.name, params: def.params as ParamSpecs } : undefined;
  };

  constructor(private readonly s: AutomationDeps) {
    s.history.onChange((c) => this.changed(c));
    s.history.onStatus(() => {
      if (!s.history.inGesture) this.dragEnded();
    });
    s.recording.register({ id: 'automation', start: () => this.startTake(), stop: () => this.stopTake() });
    s.doc.subscribe((next, prev) => {
      if (next.project.channels !== prev.project.channels || next.project.playlist !== prev.project.playlist)
        this.refresh();
    });
    s.plugins.subscribe(() => this.refresh());
  }

  private get project(): Project {
    return this.s.doc.getState().project;
  }

  // ---------------------------------------------------------------- labels and values

  /** What the target controls in plain words ("Cutoff · 3xOsc"), or null when it's gone. */
  nameOf(target: ParamTarget, project: Project = this.project): string | null {
    return targetName(project, target, this.pluginInfo);
  }

  /** The label of an automation clip's channel ("Cutoff · 3xOsc", "Tempo", "… (target deleted)"). */
  labelOf(channel: AutomationChannel, project: Project = this.project): string {
    return automationLabel(project, channel, this.pluginInfo);
  }

  /** Spec and mapping of a target (tempo through the channel's range). */
  resolve(target: ParamTarget, range?: { min: number; max: number }, project = this.project): ResolvedTarget | null {
    return resolveTarget(project, target, this.specsOf, range);
  }

  /** A normalized curve value of a target in its units ("−6.0 dB", "128 BPM", "1.20 kHz"). */
  format(target: ParamTarget, n: number, range?: { min: number; max: number }): string {
    const res = this.resolve(target, range);
    return res ? formatAutomationValue(res, target, n) : `${Math.round(n * 100)}%`;
  }

  /** Automation channels driving a target key (in channel order). */
  channelsFor(key: string, project: Project = this.project): readonly AutomationChannel[] {
    if (!this.index || this.index.channels !== project.channels || this.index.playlist !== project.playlist) {
      const byKey = new Map<string, AutomationChannel[]>();
      for (const id of project.channelOrder) {
        const ch = project.channels[id];
        if (ch?.kind !== 'automation' || !ch.target) continue;
        const k = targetKey(ch.target);
        byKey.set(k, [...(byKey.get(k) ?? []), ch]);
      }
      this.index = { channels: project.channels, playlist: project.playlist, byKey };
    }
    return this.index.byKey.get(key) ?? [];
  }

  // ---------------------------------------------------------------- create

  /**
   * "Create automation clip": an automation channel named after the target with two points at its
   * current value, and a clip on the first free track over the loop region (or 4 bars from the song
   * position). One undo step; the new clip is selected. Null for targets automation can't drive.
   */
  createClip(
    target: ParamTarget,
    at: { start?: Tick; length?: Tick } = {},
  ): { channelId: ChannelId; clipId: ClipId; laneId: LaneId } | null {
    const p = this.project;
    const range = target.kind === 'tempo' ? tempoRange(p.transport.bpm) : undefined;
    const res = this.resolve(target, range, p);
    if (!res || !isAutomatable(res.spec)) return null;
    const bar = ticksPerBar(p.transport.timeSig);
    const v = this.s.view.getState();
    const loop = v.loop && v.loop.end > v.loop.start ? v.loop : null;
    const start = at.start ?? (loop ? loop.start : Math.floor(v.songStart / bar) * bar);
    const length = at.length ?? (loop && at.start === undefined ? loop.end - loop.start : 4 * bar);
    let ids: { channelId: ChannelId; clipId: ClipId; laneId: LaneId } | null = null;
    this.s.history.transact('Create automation clip', (d) => {
      ids = createAutomationClip(d, {
        target,
        name: this.nameOf(target, p) ?? 'Automation',
        color: this.colorFor(p),
        start,
        length,
        value: res.toNormalized(res.base),
        ...(range ? { range } : {}),
      });
    });
    const made = ids as { channelId: ChannelId; clipId: ClipId; laneId: LaneId } | null;
    if (made) this.s.editor.getState().selectClips([made.clipId]);
    return made;
  }

  private colorFor(p: Project): string {
    const n = Object.values(p.channels).filter((c) => c.kind === 'automation').length;
    return PALETTE[(n * 3 + 5) % PALETTE.length] as string;
  }

  // ---------------------------------------------------------------- touch

  private changed(c: DocChange): void {
    if (c.origin === 'gesture' && this.s.history.inGesture) {
      for (const t of targetsChangedBy(c.prev, c.next, c.patches)) {
        const key = targetKey(t);
        if (t.kind === 'tempo' || this.dragged.has(key)) continue;
        this.dragged.add(key);
        if (!this.take?.latched.has(key)) this.s.engine.touch(key, true);
      }
    } else this.dragEnded();
    if (this.take && (c.origin === 'gesture' || c.origin === 'edit')) this.capture(c);
  }

  private dragEnded(): void {
    for (const key of this.dragged) if (!this.take?.latched.has(key)) this.s.engine.touch(key, false);
    this.dragged.clear();
  }

  // ---------------------------------------------------------------- recording

  /** Automation is being recorded (record mode on and playing). */
  get recording(): boolean {
    return this.take !== null;
  }

  private startTake(): void {
    this.take = { latched: new Set(), recorded: new Map(), warned: false };
  }

  private capture(c: DocChange): void {
    const take = this.take as Take;
    const targets = targetsChangedBy(c.prev, c.next, c.patches);
    if (targets.length === 0) return;
    if (this.s.view.getState().mode !== 'song') {
      if (!take.warned)
        this.s.session.getState().toast('Automation records in Song mode: switch to SONG to record knob moves');
      take.warned = true;
      return;
    }
    const tick = this.s.engine.playhead();
    const iter = this.s.engine.playheadIteration();
    for (const target of targets) {
      const key = targetKey(target);
      const range = target.kind === 'tempo' ? this.tempoRangeFor(c.prev) : undefined;
      const res = resolveTarget(c.next, target, this.specsOf, range);
      if (!res || !isAutomatable(res.spec)) continue;
      const value = res.toNormalized(res.base);
      let rec = take.recorded.get(key);
      if (!rec) {
        const was = resolveTarget(c.prev, target, this.specsOf, range);
        rec = {
          target,
          before: { tick, value: was ? was.toNormalized(was.base) : value },
          passes: [[]],
          lastIter: iter,
          lastTick: tick,
        };
        take.recorded.set(key, rec);
        take.latched.add(key);
        if (target.kind !== 'tempo' && !this.dragged.has(key)) this.s.engine.touch(key, true);
        this.refresh();
      }
      // The loop wrapped: a new pass (it replaces what earlier passes recorded where it overlaps).
      if (iter !== rec.lastIter || tick < rec.lastTick - 1) rec.passes.push([]);
      (rec.passes[rec.passes.length - 1] as Sample[]).push({ tick, value });
      rec.lastIter = iter;
      rec.lastTick = tick;
    }
  }

  private stopTake(): void {
    const take = this.take;
    this.take = null;
    if (!take) return;
    for (const key of take.latched) if (!this.dragged.has(key)) this.s.engine.touch(key, false);
    this.refresh();
    if (take.recorded.size === 0) return;
    const names: string[] = [];
    const p = this.project;
    this.s.history.transact('Record automation', (d) => {
      for (const rec of take.recorded.values()) {
        const name = this.writeTake(d, p, rec);
        if (name) names.push(name);
      }
    });
    if (names.length > 0)
      this.s.session.getState().toast(`Recorded automation: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`);
  }

  /** The tempo range of the take: the tempo clip's, or the default around the current tempo. */
  private tempoRangeFor(p: Project): { min: number; max: number } {
    const ch = this.channelsFor('tempo', p)[0];
    return ch?.range ?? tempoRange(p.transport.bpm);
  }

  /**
   * Writes one target's take: into the clip of that target that covers it (splicing the curve), or
   * into a new clip spanning the bars it was recorded in. Returns the target's name.
   */
  private writeTake(d: Draft<Project>, p: Project, rec: Recorded): string | null {
    const samples = mergePasses(rec.passes);
    if (samples.length === 0) return null;
    const t0 = (samples[0] as Sample).tick;
    const t1 = (samples[samples.length - 1] as Sample).tick;
    const key = targetKey(rec.target);
    const muted = mutedLanes(p.playlist);
    let host: { ch: AutomationChannel; start: Tick; offset: Tick } | null = null;
    for (const ch of this.channelsFor(key, p)) {
      for (const clip of Object.values(p.playlist.clips)) {
        if (clip.kind !== 'automation' || clip.channelId !== ch.id || clip.muted || muted.has(clip.laneId)) continue;
        if (clip.start <= t0 && t1 <= clip.start + clip.length && (!host || clip.start >= host.start))
          host = { ch, start: clip.start, offset: clip.offset };
      }
    }
    const name = this.nameOf(rec.target, p) ?? 'Automation';
    if (host) {
      const h = host;
      const take = thinSamples(
        samples.map((s) => ({ tick: s.tick - h.start + h.offset, value: s.value })),
        THIN,
      );
      setAutomationPoints(d, h.ch.id, spliceCurve(h.ch.points, take));
      return name;
    }
    const bar = ticksPerBar(p.transport.timeSig);
    const start = Math.floor(t0 / bar) * bar;
    const end = Math.max(start + bar, Math.ceil((t1 + 1) / bar) * bar);
    const take = thinSamples(
      [rec.before, ...samples].map((s) => ({ tick: s.tick - start, value: s.value })),
      THIN,
    );
    const first = take[0];
    const last = take[take.length - 1];
    const points = [
      ...(first && first.tick > 0 ? [{ tick: 0, value: first.value }] : []),
      ...take,
      ...(last && last.tick < end - start ? [{ tick: end - start, value: last.value }] : []),
    ];
    const range = rec.target.kind === 'tempo' ? this.tempoRangeFor(p) : undefined;
    createAutomationClip(d, {
      target: rec.target,
      name,
      color: this.colorFor(d as Project),
      start,
      length: end - start,
      points,
      ...(range ? { range } : {}),
    });
    return name;
  }

  // ---------------------------------------------------------------- status for controls

  /**
   * Calls `cb` with the target's status now and whenever it changes (automated by a clip, muted, or
   * being recorded; null for a plain control). Returns the unsubscribe function.
   */
  watch(key: string, cb: (status: AutomationStatus | null) => void): () => void {
    let set = this.watchers.get(key);
    if (!set) this.watchers.set(key, (set = new Set()));
    set.add(cb);
    const status = this.statusOf(key);
    this.shown.set(key, status ? `${status.kind}|${status.hint}` : '');
    cb(status);
    return () => {
      const s2 = this.watchers.get(key);
      s2?.delete(cb);
      if (s2 && s2.size === 0) {
        this.watchers.delete(key);
        this.shown.delete(key);
      }
    };
  }

  /** A target's status (see watch). */
  statusOf(key: string): AutomationStatus | null {
    if (this.take?.latched.has(key))
      return { kind: 'recording', hint: 'Recording automation: your moves are written to a clip when you stop' };
    const p = this.project;
    const channels = this.channelsFor(key, p);
    if (channels.length === 0) return null;
    const muted = mutedLanes(p.playlist);
    let playing = 0;
    let any = 0;
    for (const clip of Object.values(p.playlist.clips)) {
      if (clip.kind !== 'automation' || !channels.some((c) => c.id === clip.channelId)) continue;
      any++;
      const ch = p.channels[clip.channelId];
      if (!clip.muted && !muted.has(clip.laneId) && !ch?.muted) playing++;
    }
    if (any === 0) return null;
    const name = this.labelOf(channels[0] as AutomationChannel, p);
    if (playing === 0) return { kind: 'muted', hint: `Its automation clip ‘${name}’ is muted – right-click for options` };
    return {
      kind: 'automated',
      hint:
        channels.length === 1
          ? `Automated by clip ‘${name}’ – right-click to edit`
          : `Automated by ${channels.length} clips (‘${name}’…) – right-click to edit`,
    };
  }

  private refresh(): void {
    for (const [key, set] of this.watchers) {
      const status = this.statusOf(key);
      const sig = status ? `${status.kind}|${status.hint}` : '';
      if ((this.shown.get(key) ?? '') === sig) continue;
      this.shown.set(key, sig);
      for (const cb of set) cb(status);
    }
  }
}
