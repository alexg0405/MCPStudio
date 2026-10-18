/**
 * Lookahead transport: turns the pure plan()/collectNotes() core into timed noteOn/noteOff calls.
 * It knows nothing about Web Audio beyond a clock, so it runs the same against a realtime context,
 * an OfflineAudioContext (export) or a fake clock in tests.
 *
 * Live edits re-anchor: every not-yet-started note is cancelled (noteOff at its own start time
 * cancels it), planning restarts 10 ms from now with the new model, and sounding notes whose
 * source was deleted are released.
 */
import type { AudioClip, ChannelId, Clip, LaneId, Project, Tick } from '@core/model/types';
import { followsTempo, playbackKey, playbackMode } from '@core/audio/playback';
import { ticksPerBar, type TempoMap } from '@core/time/ppq';
import type { NoteOff, NoteOn } from '@agstudio/sdk';
import { plan, segmentEndTime, tickAtTime, tickNumberAt, timeInSegment, type Cursor, type Segment, type Timeline } from './core';
import { collectAudio, collectNotes, type EventSource, type NoteEvent } from './events';
import type { LaunchRun } from '@core/launcher/run';
import { advanceTick, launchPassTempo, retreatTick } from './launch-tempo';
import { collectLaunchAudio, collectLaunchNotes, laneOverridden, overrideStartAfter } from './launch';

/** A planned segment with the launcher axis position of its start (`u`: see core/launcher/run.ts). */
export type USegment = Segment & { u0: number };

/** An audio clip starting to play: its note-on plus where it starts in the song and the tempo it plays at. */
export interface AudioOn extends NoteOn {
  clip: AudioClip;
  /** Song tick at `time`: the clip's start, or later when playback starts inside the clip. */
  tick: number;
  /** The tempo map of this run: the context time of a later tick is `time + T(tick') − T(tick)`. */
  tempo: TempoMap;
}

export interface TransportSink {
  noteOn(channelId: ChannelId, e: NoteOn): void;
  noteOff(channelId: ChannelId, e: NoteOff): void;
  allNotesOff(time: number): void;
  /** Audio clip starts (gain, fades, pitch, tempo follow need the clip); without it they arrive as noteOn. */
  audioOn?(channelId: ChannelId, e: AudioOn): void;
}

export interface Clock {
  readonly currentTime: number;
}

/**
 * Follows the transport's timeline (the metronome, the automation driver, note recording). Calls
 * happen on the main thread while planning, ahead of the audio.
 */
export interface TransportObserver {
  /** Playback starts at `tick`, heard from `time`. */
  started?(tick: Tick, time: number): void;
  /** A newly planned segment, before its notes go out. `wrapped`: it starts the loop again. */
  segment?(seg: Segment, wrapped: boolean): void;
  /**
   * The model changed while playing and everything from `time` on is planned again
   * (`timelineChanged`: tempo, loop or length changed too).
   */
  reanchored?(time: number, timelineChanged: boolean): void;
  /** Playback jumped to `tick`, heard from `time` (a seek while playing). */
  seeked?(tick: Tick, time: number): void;
  /** Playback stopped at `time`. */
  stopped?(time: number): void;
}

interface Scheduled {
  ev: NoteEvent;
  noteId: number;
  startTime: number;
  iter: number;
  /** Absolute end tick (may change on live edits). */
  endTick: number;
  offSent: boolean;
  /** Audio events: the playlist clip as it was when its sample started. */
  clip?: Clip;
  /** Audio events: how the channel played it (see playbackKey) and whether its speed follows the tempo. */
  audioKey?: string;
  follows?: boolean;
  /** Launcher notes: their end is a position on the launcher axis, not a song tick. */
  launch?: boolean;
  endU?: number;
  /** Song notes: where they started on the launcher axis, and the playlist track they belong to (a launcher track may take it over). */
  startU?: number;
  laneId?: LaneId;
}

/**
 * A note that starts less than this far (seconds) after "now" has already reached the audio thread and can no longer
 * be cancelled; a re-plan starts this far ahead of the clock.
 */
const SAFETY_SEC = 0.01;
/** The default lookahead (seconds): how far past the clock the scheduler plans on each tick. */
const DEFAULT_LOOKAHEAD_SEC = 0.12;
/** The default delay between a start or seek and its first beat (seconds), when the caller gives none. */
const DEFAULT_START_DELAY_SEC = 0.04;
/** A release is nudged this far (seconds) past the note's start, because a release at the start time would cancel it. */
const RELEASE_NUDGE_SEC = 1e-4;
/** Rounding slack when comparing positions on the launcher axis (ticks). */
const U_EPSILON = 1e-6;
/** Rounding slack when comparing a segment's end with the loop or song end (ticks). */
const END_EPSILON = 1e-9;
/** Past this many remembered runs, the ones that are gone are forgotten. */
const MAX_REMEMBERED_RUNS = 256;
/** Planned segments are kept this long after they end (seconds), for the playhead and the tempo readouts. */
const KEEP_SEGMENTS_SEC = 2;

export class Transport {
  private playingFlag = false;
  private cursor: Cursor | null = null;
  private segs: USegment[] = [];
  /** The launcher axis position of the planning cursor. */
  private uFrontier = 0;
  /** Every dispatched note until it has both started and been released. */
  private notes = new Map<number, Scheduled>();
  private noteSeq = 0;
  private endTime: number | null = null;
  private stoppedTick: Tick = 0;
  /** Next segment should also start audio clips already in progress (after start/seek/re-anchor). */
  private scanOngoing = false;
  /** Runs whose start the planner has passed (their notes were collected, or they were already going): see `catchUp`. */
  private launchDone = new Set<string>();
  /**
   * Runs that start before the cursor of a re-plan and were never planned (a press that came before its boundary
   * was heard: the grace rule, see core/launcher/run.ts): the next segment also plays their notes from their start,
   * late, from `catchFrom` on.
   */
  private catchUp: { runs: LaunchRun[]; from: number } | null = null;
  lookahead: number;
  lateEvents = 0;
  private readonly observers = new Set<TransportObserver>();

  constructor(
    private readonly clock: Clock,
    private readonly sink: TransportSink,
    private source: EventSource,
    private timeline: Timeline,
    opts: { lookahead?: number } = {},
  ) {
    this.lookahead = opts.lookahead ?? DEFAULT_LOOKAHEAD_SEC;
  }

  get playing(): boolean {
    return this.playingFlag;
  }

  /** The timeline being planned (tempo map, loop, end): the one segments come from. */
  get currentTimeline(): Timeline {
    return this.timeline;
  }

  /** Adds an observer of the timeline; returns its removal. */
  observe(o: TransportObserver): () => void {
    this.observers.add(o);
    return () => this.observers.delete(o);
  }

  /** Number of notes awaiting a noteOn or noteOff (diagnostics/tests). */
  get pendingNotes(): number {
    return this.notes.size;
  }

  start(fromTick: Tick, at: number = this.clock.currentTime + DEFAULT_START_DELAY_SEC): void {
    this.reset();
    this.playingFlag = true;
    this.endTime = null;
    this.scanOngoing = true;
    this.cursor = { tick: fromTick, time: at, iter: 0 };
    this.uFrontier = fromTick;
    this.markLaunchDone(fromTick);
    for (const o of this.observers) o.started?.(fromTick, at);
    this.pump();
  }

  /**
   * Jumps while playing: notes that haven't started are cancelled, sounding ones are released at
   * `at`, and playback continues from `tick` at `at`. While stopped it only moves the stop position.
   */
  seek(tick: Tick, at: number = this.clock.currentTime + DEFAULT_START_DELAY_SEC): void {
    if (!this.playingFlag || !this.cursor) {
      this.stoppedTick = tick;
      return;
    }
    const now = this.clock.currentTime;
    for (const n of this.notes.values()) {
      if (n.startTime >= now + SAFETY_SEC) {
        this.sink.noteOff(n.ev.channelId, { time: n.startTime, noteId: n.noteId, key: n.ev.pitch });
        n.offSent = true;
      } else if (!n.offSent) this.release(n, at);
    }
    // The launcher axis keeps counting through a seek, lined up with the new position's bars.
    const bar = this.source.project ? ticksPerBar(this.source.project.transport.timeSig) : 0;
    const u = this.uAtTime(at);
    this.uFrontier = bar > 0 ? u + ((((tick - u) % bar) + bar) % bar) : u;
    this.markLaunchDone(this.uFrontier);
    this.notes.clear();
    this.segs = [];
    this.endTime = null;
    this.scanOngoing = true;
    this.cursor = { tick, time: at, iter: 0 };
    for (const o of this.observers) o.seeked?.(tick, at);
    this.pump();
  }

  /** Stops playback; FL returns the playhead to the start. */
  stop(returnTo: Tick = 0): void {
    if (this.playingFlag) {
      const now = this.clock.currentTime;
      this.sink.allNotesOff(now);
      for (const o of this.observers) o.stopped?.(now);
    }
    this.reset();
    this.playingFlag = false;
    this.stoppedTick = returnTo;
  }

  /** Plans and dispatches everything up to `horizon` (defaults to now + lookahead). */
  pump(horizon: number = this.clock.currentTime + this.lookahead): void {
    if (!this.playingFlag || !this.cursor) return;
    if (this.endTime !== null && this.clock.currentTime >= this.endTime) {
      this.stop();
      this.onEnded?.();
      return;
    }
    const planned = plan(this.cursor, horizon, this.timeline);
    const loop = this.timeline.loop;
    for (const plain of planned.segs) {
      const seg: USegment = { ...plain, u0: this.uFrontier };
      this.uFrontier += seg.tick1 - seg.tick0;
      const wrapped = !!loop && seg.iter > 0 && seg.tick0 === loop.start;
      for (const observer of this.observers) observer.segment?.(seg, wrapped);
      this.process(seg);
      this.segs.push(seg);
    }
    this.cursor = planned.next;
    if (planned.ended && this.endTime === null) this.endTime = planned.next.time;
    this.trim();
  }

  /** Called when the song (non-looping timeline) has finished playing. */
  onEnded?: () => void;

  /**
   * New model while playing: cancel what hasn't started, re-plan from now + 10 ms. While stopped
   * it just stores the model.
   */
  setModel(source: EventSource, timeline: Timeline): void {
    this.source = source;
    const loopChanged =
      timeline.loop?.start !== this.timeline.loop?.start || timeline.loop?.end !== this.timeline.loop?.end;
    const tempoChanged = timeline.tempo !== this.timeline.tempo;
    const timelineChanged = tempoChanged || timeline.endTick !== this.timeline.endTick || loopChanged;
    this.timeline = timeline;
    if (!this.playingFlag || !this.cursor) return;
    const now = this.clock.currentTime;
    const safe = now + SAFETY_SEC;
    const position = tickAtTime(this.segs, safe) ?? { tick: this.cursor.tick, iter: this.cursor.iter };
    const uPosition = this.uAtTime(safe);

    this.cancelNotesNotStarted(safe);
    this.dropPlannedFuture(safe, position.tick);
    const tick = loopChanged ? this.wrapIntoLoop(position.tick, timeline.loop) : position.tick;
    this.cursor = { tick, time: safe, iter: position.iter };
    this.uFrontier = uPosition;
    this.endTime = null;
    this.catchUp = this.runsToCatchUp(source, uPosition);
    this.reviseSoundingNotes({ now, safe, uPosition, tick, iter: position.iter, tempoChanged });
    this.scanOngoing = true;
    for (const observer of this.observers) observer.reanchored?.(safe, timelineChanged);
    this.pump();
  }

  /** Notes that start at or after `safe` have not reached the audio thread's clock yet: they are cancelled. */
  private cancelNotesNotStarted(safe: number): void {
    for (const scheduled of [...this.notes.values()]) {
      if (scheduled.startTime < safe) continue;
      this.sink.noteOff(scheduled.ev.channelId, { time: scheduled.startTime, noteId: scheduled.noteId, key: scheduled.ev.pitch });
      this.notes.delete(scheduled.noteId);
    }
  }

  /** Drops the planned future; keeps the past for the playhead. */
  private dropPlannedFuture(safe: number, tickAtSafe: Tick): void {
    this.segs = this.segs.filter((seg) => seg.time0 < safe);
    const last = this.segs[this.segs.length - 1];
    if (last && segmentEndTime(last) > safe) this.segs[this.segs.length - 1] = { ...last, tick1: tickAtSafe };
  }

  /** A new loop region may leave the position outside it: the position wraps into the loop as playback would. */
  private wrapIntoLoop(tick: Tick, loop: Timeline['loop']): Tick {
    if (!loop || loop.end <= loop.start || (tick >= loop.start && tick < loop.end)) return tick;
    const length = loop.end - loop.start;
    return loop.start + ((((tick - loop.start) % length) + length) % length);
  }

  /** Runs that start before the new cursor and were never planned (they were launched on a boundary a few ms ago). */
  private runsToCatchUp(source: EventSource, uPosition: number): { runs: LaunchRun[]; from: number } | null {
    const late = source.launch?.runs.filter(
      (run) => run.startU < uPosition - U_EPSILON && !this.launchDone.has(run.id) && run.content.kind === 'pattern',
    );
    if (!late || late.length === 0) return null;
    return { runs: late, from: Math.min(...late.map((run) => run.startU)) };
  }

  /** Sounding notes after a re-plan: release those whose source disappeared, follow length changes. */
  private reviseSoundingNotes(at: {
    now: number;
    safe: number;
    uPosition: number;
    tick: Tick;
    iter: number;
    tempoChanged: boolean;
  }): void {
    const project = this.source.project;
    for (const scheduled of [...this.notes.values()]) {
      if (scheduled.offSent) continue;
      const ev = scheduled.ev;
      const channel = project.channels[ev.channelId];
      if (ev.launch) {
        this.reviseLauncherNote(scheduled, project, at);
        continue;
      }
      const end = ev.kind === 'audio' ? this.audioClipEnd(scheduled, project, at.tempoChanged) : this.patternNoteEnd(ev, project);
      if (end === null || !channel) {
        this.release(scheduled, at.safe);
        continue;
      }
      scheduled.endTick = end;
      if (scheduled.iter === at.iter && scheduled.endTick <= at.tick) this.release(scheduled, at.safe);
    }
  }

  /**
   * A launcher note goes on while its run does (a cut run ends its notes at the cut): releases it when its run, its
   * channel or its note is gone, silences one whose run was cut before it began, and follows length changes.
   */
  private reviseLauncherNote(
    scheduled: Scheduled,
    project: Project,
    at: { now: number; safe: number; uPosition: number; tempoChanged: boolean },
  ): void {
    const ev = scheduled.ev;
    const channel = project.channels[ev.channelId];
    const run = this.source.launch?.runs.find((r) => r.id === ev.launch?.runId);
    const runEnd = run ? (run.endU ?? Infinity) : -1;
    let keep = !!run && !!channel;
    if (keep && ev.kind === 'audio') {
      keep =
        channel?.kind === 'audioClip' &&
        playbackKey(channel) === scheduled.audioKey &&
        !(at.tempoChanged && scheduled.follows) &&
        run?.content.kind === 'audio' &&
        run.content.channelId === ev.channelId;
    } else if (keep && ev.patternId && ev.noteId) {
      keep = !!project.patterns[ev.patternId]?.notes[ev.channelId]?.[ev.noteId];
    }
    if (!keep) {
      this.release(scheduled, at.safe);
    } else if (scheduled.startTime >= at.now && ev.start >= runEnd) {
      // Its run was cut before it began (a stop or replacement on a boundary a moment ago): it never sounds.
      this.sink.noteOff(ev.channelId, { time: scheduled.startTime, noteId: scheduled.noteId, key: ev.pitch });
      scheduled.offSent = true;
    } else {
      const note =
        ev.kind === 'note' && ev.patternId && ev.noteId ? project.patterns[ev.patternId]?.notes[ev.channelId]?.[ev.noteId] : undefined;
      scheduled.endU = Math.min(note ? ev.start + note.length : ev.end, runEnd);
      // Ended already: at its own end when that is still ahead of the clock (a cut a few ms ago), else now.
      if (scheduled.endU <= at.uPosition) {
        this.release(scheduled, Math.min(at.safe, Math.max(scheduled.startTime, this.timeAtU(scheduled.endU) ?? at.safe)));
      }
    }
  }

  /**
   * Where a sounding audio clip note ends after an edit, or null when it must be released. An edited clip (moved,
   * trimmed…) restarts from the new model; an untouched one keeps playing, unless its channel now plays it differently
   * (pitch, reverse, tempo follow, another sample) or the tempo changed under a clip that follows it.
   */
  private audioClipEnd(scheduled: Scheduled, project: Project, tempoChanged: boolean): Tick | null {
    const ev = scheduled.ev;
    const clip = project.playlist.clips[ev.clipId as keyof typeof project.playlist.clips];
    const channel = project.channels[ev.channelId];
    const unchanged =
      clip?.kind === 'audio' &&
      clip.channelId === ev.channelId &&
      clip === scheduled.clip &&
      channel?.kind === 'audioClip' &&
      playbackKey(channel) === scheduled.audioKey &&
      !(tempoChanged && scheduled.follows);
    return unchanged ? clip.start + clip.length : null;
  }

  /** Where a sounding pattern note ends after an edit (its note's length, within its clip), or null when it is gone. */
  private patternNoteEnd(ev: NoteEvent, project: Project): Tick | null {
    if (!ev.patternId || !ev.noteId) return null;
    const note = project.patterns[ev.patternId]?.notes[ev.channelId]?.[ev.noteId];
    const clipGone = ev.clipId !== 'pattern' && !project.playlist.clips[ev.clipId as keyof typeof project.playlist.clips];
    return note && !clipGone ? Math.min(ev.start + note.length, ev.clipEnd) : null;
  }

  /**
   * The tick (and loop pass) at audio-clock `time`, extrapolated at the current tempo before and
   * after what is planned; the stop position while stopped.
   */
  tickAt(time: number): { tick: number; iter: number } {
    if (!this.playingFlag) return { tick: this.stoppedTick, iter: 0 };
    const hit = tickAtTime(this.segs, time);
    const last = this.segs[this.segs.length - 1];
    const first = this.segs[0];
    if (hit && !(last && time > segmentEndTime(last))) return hit;
    if (last && time > segmentEndTime(last))
      return { tick: last.tick1 + (time - segmentEndTime(last)) / last.spt, iter: last.iter };
    if (first) return { tick: first.tick0 - (first.time0 - time) / first.spt, iter: first.iter };
    const c = this.cursor;
    return c
      ? { tick: c.tick + (time - c.time) / this.timeline.tempo.secondsPerTick(c.tick), iter: c.iter }
      : { tick: 0, iter: 0 };
  }

  /** Seconds per tick heard at audio-clock `time` (the timeline's tempo at the stop position when stopped). */
  sptAt(time: number): number {
    for (let i = this.segs.length - 1; i >= 0; i--) {
      const s = this.segs[i] as Segment;
      if (time >= s.time0) return s.spt;
    }
    const first = this.segs[0];
    return first
      ? first.spt
      : this.timeline.tempo.secondsPerTick(this.playingFlag ? (this.cursor?.tick ?? 0) : this.stoppedTick);
  }

  /** Tick heard at audio-clock `time` (the UI passes the output-latency-corrected time). */
  positionAt(time: number): number {
    if (!this.playingFlag) return this.stoppedTick;
    // A number, not the {tick, iter} object tickAtTime makes: this is read several times in every frame.
    const tick = tickNumberAt(this.segs, time);
    if (tick !== null) return tick;
    return this.segs[0]?.tick0 ?? this.cursor?.tick ?? this.stoppedTick;
  }

  /**
   * The position on the launcher axis (see core/launcher/run.ts) at audio-clock `time`, extrapolated at the planned
   * tempo before and after what is planned. 0 while stopped.
   */
  uAtTime(time: number): number {
    if (!this.playingFlag) return 0;
    const segs = this.segs;
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i] as USegment;
      if (time >= s.time0) {
        if (time <= segmentEndTime(s)) return s.u0 + (time - s.time0) / s.spt;
        return s.u0 + (s.tick1 - s.tick0) + (time - segmentEndTime(s)) / s.spt;
      }
    }
    const first = segs[0];
    if (first) return first.u0 - (first.time0 - time) / first.spt;
    const c = this.cursor;
    return c ? this.uFrontier + (time - c.time) / this.timeline.tempo.secondsPerTick(c.tick) : this.uFrontier;
  }

  /**
   * The song tick launcher tick `u` is (or will be) played at: on the planned segments, past them by carrying the
   * plan on (loop wraps included).
   */
  tickAtU(u: number): number {
    if (!this.playingFlag) return u;
    for (let i = this.segs.length - 1; i >= 0; i--) {
      const s = this.segs[i] as USegment;
      if (u >= s.u0 && u <= s.u0 + (s.tick1 - s.tick0)) return s.tick0 + (u - s.u0);
    }
    if (this.cursor && u >= this.uFrontier) return advanceTick(this.timeline, this.cursor.tick, u - this.uFrontier);
    const first = this.segs[0];
    return first ? Math.max(0, first.tick0 - (first.u0 - u)) : u;
  }

  /** The tempo a launched pass over launcher ticks [u0, u1] plays under, on the plan as it stands (see launch-tempo.ts). */
  launchTempo(u0: number, u1: number): TempoMap {
    return launchPassTempo(this.timeline, this.tickAtU(u0), u0, u1);
  }

  /** The loop iteration heard at `time` (UI uses it for the current step light). */
  iterationAt(time: number): number {
    return tickAtTime(this.segs, time)?.iter ?? 0;
  }

  /** Collects, dispatches and releases everything a newly planned segment holds. */
  private process(seg: USegment): void {
    const now = this.clock.currentTime;
    const loop = this.timeline.loop;
    // Audio clips also start mid-way after a start/seek/edit, or when the loop wraps into one, unless
    // their sample is still playing from before an edit.
    const wrapped = !!loop && seg.iter > 0 && seg.tick0 === loop.start;
    const scan = this.scanOngoing || wrapped;
    const events: NoteEvent[] = [];
    this.collectSongEvents(seg, scan, events);
    const u1 = seg.u0 + (seg.tick1 - seg.tick0);
    const runs = this.source.launch?.runs;
    const launcherEvents: NoteEvent[] = [];
    if (runs && runs.length > 0) this.collectLauncherEvents(seg, runs, u1, scan, events, launcherEvents);
    // Runs that began a few ms before this segment (never planned): their notes from the start, late but on the boundary.
    const caughtUpEvents: NoteEvent[] = [];
    if (this.catchUp) {
      collectLaunchNotes(this.source.project, this.catchUp.runs, this.catchUp.from, seg.u0, caughtUpEvents);
      this.catchUp = null;
    }
    this.scanOngoing = false;
    for (const event of events) this.dispatch(seg, event, 'song', now);
    for (const event of caughtUpEvents) this.dispatch(seg, event, 'caughtUp', now);
    for (const event of launcherEvents) this.dispatch(seg, event, 'launcher', now);
    this.releaseEnded(seg, runs, u1);
  }

  /** The notes and audio clip starts of the song (pattern or playlist) inside the segment. */
  private collectSongEvents(seg: USegment, scan: boolean, events: NoteEvent[]): void {
    collectNotes(this.source, seg.tick0, seg.tick1, events);
    let sounding: Set<string> | undefined;
    if (scan) {
      sounding = new Set();
      for (const scheduled of this.notes.values()) {
        const isSongAudio = scheduled.ev.kind === 'audio' && !scheduled.offSent && scheduled.iter === seg.iter && !scheduled.launch;
        if (isSongAudio) sounding.add(scheduled.ev.clipId);
      }
    }
    collectAudio(this.source, seg.tick0, seg.tick1, events, scan ? seg.tick0 : null, this.timeline.tempo, sounding);
  }

  /**
   * The launcher's notes and audio passes inside the segment (into `launcherEvents`). A launcher track takes over its
   * playlist track from where its slot starts: the song's events under it are removed from `songEvents`.
   */
  private collectLauncherEvents(
    seg: USegment,
    runs: readonly LaunchRun[],
    u1: number,
    scan: boolean,
    songEvents: NoteEvent[],
    launcherEvents: NoteEvent[],
  ): void {
    const clipsById = this.source.project?.playlist.clips;
    if (clipsById) {
      let kept = 0;
      for (const event of songEvents) {
        const lane = clipsById[event.clipId as keyof typeof clipsById]?.laneId;
        if (lane && laneOverridden(runs, lane, seg.u0 + (event.start - seg.tick0))) continue;
        songEvents[kept++] = event;
      }
      songEvents.length = kept;
    }
    collectLaunchNotes(this.source.project, runs, seg.u0, u1, launcherEvents);
    let launchSounding: Set<string> | undefined;
    if (scan) {
      launchSounding = new Set();
      for (const scheduled of this.notes.values()) {
        if (scheduled.launch && scheduled.ev.kind === 'audio' && !scheduled.offSent) launchSounding.add(scheduled.ev.clipId);
      }
    }
    collectLaunchAudio(this.source.project, runs, seg.u0, u1, launcherEvents, scan ? seg.u0 : null, launchSounding);
    for (const run of runs) if (run.startU < u1) this.launchDone.add(run.id);
  }

  /**
   * Sends one event to the sink as a note-on (or an audio clip start) and remembers it until it has both started
   * and been released. 'caughtUp' events are late on purpose (the grace rule): that is not the scheduler falling
   * behind, so it must not raise the lookahead.
   */
  private dispatch(seg: USegment, event: NoteEvent, kind: 'song' | 'launcher' | 'caughtUp', now: number): void {
    const isLauncher = kind !== 'song';
    const tempo = this.timeline.tempo;
    const time = isLauncher ? seg.time0 + (event.start - seg.u0) * seg.spt : timeInSegment(seg, event.start, tempo);
    if (time < now && kind !== 'caughtUp') this.lateEvents++;
    const noteId = ++this.noteSeq;
    const scheduled: Scheduled = {
      ev: event,
      noteId,
      startTime: time,
      iter: seg.iter,
      endTick: event.end,
      offSent: false,
      ...(isLauncher ? { launch: true, endU: event.end } : { startU: seg.u0 + (event.start - seg.tick0) }),
    };
    let audioClip: AudioClip | null = null;
    let eventTempo = tempo;
    const clips = this.source.project?.playlist.clips;
    if (event.kind === 'audio' && isLauncher && event.launch?.clip) {
      // A pass of a slot's audio: its clip starts on the launcher axis, which runs at the song's tempo along the way
      // (a constant map unless the tempo changes during the pass: see launch-tempo.ts).
      audioClip = event.launch.clip;
      scheduled.clip = audioClip;
      // (A pass already going when planned (a re-plan) is followed back to its start: fades and 'off' read from there.)
      eventTempo = launchPassTempo(
        this.timeline,
        retreatTick(this.timeline, seg.tick0 + (event.start - seg.u0), event.start - audioClip.start),
        audioClip.start,
        audioClip.start + audioClip.length,
      );
    } else if (!isLauncher && clips) {
      const clip = clips[event.clipId as keyof typeof clips];
      if (clip) {
        scheduled.laneId = clip.laneId;
        if (event.kind === 'audio') scheduled.clip = clip;
        if (event.kind === 'audio' && clip.kind === 'audio') audioClip = clip;
      }
    }
    if (event.kind === 'audio') {
      const channel = this.source.project.channels[event.channelId];
      if (channel?.kind === 'audioClip') {
        scheduled.audioKey = playbackKey(channel);
        scheduled.follows = followsTempo(playbackMode(channel));
      }
    }
    this.notes.set(noteId, scheduled);
    const noteOn: NoteOn = {
      time,
      noteId,
      key: event.pitch,
      velocity: event.velocity,
      ...(event.pan !== undefined ? { pan: event.pan } : {}),
      ...(event.fine !== undefined ? { fine: event.fine } : {}),
      ...(event.offsetSec !== undefined ? { offset: event.offsetSec } : {}),
    };
    if (audioClip && this.sink.audioOn) {
      this.sink.audioOn(event.channelId, { ...noteOn, clip: audioClip, tick: event.start, tempo: eventTempo });
    } else {
      this.sink.noteOn(event.channelId, noteOn);
    }
  }

  /** Schedules the release of every note of the song or the launcher that ends inside (or before) the segment. */
  private releaseEnded(seg: USegment, runs: readonly LaunchRun[] | undefined, u1: number): void {
    const loop = this.timeline.loop;
    const tempo = this.timeline.tempo;
    const atLoopEnd = !!loop && seg.tick1 >= loop.end - END_EPSILON;
    const atSongEnd = !loop && seg.tick1 >= this.timeline.endTick - END_EPSILON;
    const segmentEnd = segmentEndTime(seg);
    for (const scheduled of this.notes.values()) {
      if (scheduled.offSent) continue;
      if (scheduled.launch) {
        // Launcher notes end at their position on the launcher axis (a loop wrap does not end them).
        const endU = scheduled.endU as number;
        if (endU < u1) this.release(scheduled, Math.max(scheduled.startTime, seg.time0 + (endU - seg.u0) * seg.spt));
        continue;
      }
      // A launcher track taking over the note's playlist track cuts it where its slot starts.
      if (runs && runs.length > 0 && scheduled.laneId && scheduled.startU !== undefined) {
        const cutU = overrideStartAfter(runs, scheduled.laneId, scheduled.startU);
        if (cutU !== null && cutU < u1) {
          this.release(scheduled, Math.max(scheduled.startTime, seg.time0 + (cutU - seg.u0) * seg.spt));
          continue;
        }
      }
      if (scheduled.iter < seg.iter) {
        this.release(scheduled, seg.time0);
      } else if (scheduled.iter === seg.iter && scheduled.endTick < seg.tick1) {
        this.release(scheduled, Math.max(scheduled.startTime, timeInSegment(seg, scheduled.endTick, tempo)));
      } else if (scheduled.iter === seg.iter && (atLoopEnd || atSongEnd)) {
        this.release(scheduled, segmentEnd);
      }
    }
  }

  /**
   * Releases every note that has started and has no release scheduled yet, at `time`. For an offline
   * render of a span of the song that stops where notes are still sounding, or end exactly there (a
   * note's release is dispatched with the segment after the one that ends at its end tick, and a span
   * has none): without it they would ring through the whole tail.
   */
  releaseHeld(time: number): void {
    for (const n of this.notes.values()) if (!n.offSent) this.release(n, time);
  }

  private release(n: Scheduled, time: number): void {
    n.offSent = true;
    // A release at the start time would cancel the note; nudge it just past the start.
    const t = time <= n.startTime ? n.startTime + RELEASE_NUDGE_SEC : time;
    this.sink.noteOff(n.ev.channelId, {
      time: t,
      noteId: n.noteId,
      key: n.ev.pitch,
      ...(n.ev.release !== undefined ? { release: n.ev.release } : {}),
    });
  }

  /** The runs that start before `u` are over as far as planning goes (they were going before this plan began). */
  private markLaunchDone(u: number): void {
    this.launchDone = new Set((this.source.launch?.runs ?? []).filter((r) => r.startU < u).map((r) => r.id));
    this.catchUp = null;
  }

  /** The context time of launcher tick `u` on the planned segments (null before the first one). */
  private timeAtU(u: number): number | null {
    for (let i = this.segs.length - 1; i >= 0; i--) {
      const s = this.segs[i] as USegment;
      if (u >= s.u0) return s.time0 + (u - s.u0) * s.spt;
    }
    return null;
  }

  private trim(): void {
    const now = this.clock.currentTime;
    if (this.launchDone.size > MAX_REMEMBERED_RUNS) {
      const live = new Set((this.source.launch?.runs ?? []).map((r) => r.id));
      for (const id of this.launchDone) if (!live.has(id)) this.launchDone.delete(id);
    }
    for (const [id, n] of this.notes) if (n.offSent && n.startTime < now) this.notes.delete(id);
    const keepAfter = now - KEEP_SEGMENTS_SEC;
    let i = 0;
    while (i < this.segs.length - 1 && segmentEndTime(this.segs[i] as Segment) < keepAfter) i++;
    if (i > 0) this.segs.splice(0, i);
  }

  private reset(): void {
    this.notes.clear();
    this.segs = [];
    this.cursor = null;
    this.launchDone.clear();
    this.catchUp = null;
  }
}
