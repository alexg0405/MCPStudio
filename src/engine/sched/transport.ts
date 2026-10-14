/**
 * Lookahead transport: turns the pure plan()/collectNotes() core into timed noteOn/noteOff calls.
 * It knows nothing about Web Audio beyond a clock, so it runs the same against a realtime context,
 * an OfflineAudioContext (export) or a fake clock in tests.
 *
 * Live edits re-anchor: every not-yet-started note is cancelled (noteOff at its own start time
 * cancels it), planning restarts 10 ms from now with the new model, and sounding notes whose
 * source was deleted are released.
 */
import type { AudioClip, ChannelId, Clip, Tick } from '@core/model/types';
import { followsTempo, playbackKey, playbackMode } from '@core/audio/playback';
import type { TempoMap } from '@core/time/ppq';
import type { NoteOff, NoteOn } from '@agstudio/sdk';
import { plan, segmentEndTime, tickAtTime, timeInSegment, type Cursor, type Segment, type Timeline } from './core';
import { collectAudio, collectNotes, type EventSource, type NoteEvent } from './events';

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
}

const SAFETY = 0.01;

export class Transport {
  private playingFlag = false;
  private cursor: Cursor | null = null;
  private segs: Segment[] = [];
  /** Every dispatched note until it has both started and been released. */
  private notes = new Map<number, Scheduled>();
  private noteSeq = 0;
  private endTime: number | null = null;
  private stoppedTick: Tick = 0;
  /** Next segment should also start audio clips already in progress (after start/seek/re-anchor). */
  private scanOngoing = false;
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
    this.lookahead = opts.lookahead ?? 0.12;
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

  start(fromTick: Tick, at: number = this.clock.currentTime + 0.04): void {
    this.reset();
    this.playingFlag = true;
    this.endTime = null;
    this.scanOngoing = true;
    this.cursor = { tick: fromTick, time: at, iter: 0 };
    for (const o of this.observers) o.started?.(fromTick, at);
    this.pump();
  }

  /**
   * Jumps while playing: notes that haven't started are cancelled, sounding ones are released at
   * `at`, and playback continues from `tick` at `at`. While stopped it only moves the stop position.
   */
  seek(tick: Tick, at: number = this.clock.currentTime + 0.04): void {
    if (!this.playingFlag || !this.cursor) {
      this.stoppedTick = tick;
      return;
    }
    const now = this.clock.currentTime;
    for (const n of this.notes.values()) {
      if (n.startTime >= now + SAFETY) {
        this.sink.noteOff(n.ev.channelId, { time: n.startTime, noteId: n.noteId, key: n.ev.pitch });
        n.offSent = true;
      } else if (!n.offSent) this.release(n, at);
    }
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
    const p = plan(this.cursor, horizon, this.timeline);
    const L = this.timeline.loop;
    for (const seg of p.segs) {
      const wrapped = !!L && seg.iter > 0 && seg.tick0 === L.start;
      for (const o of this.observers) o.segment?.(seg, wrapped);
      this.process(seg);
      this.segs.push(seg);
    }
    this.cursor = p.next;
    if (p.ended && this.endTime === null) this.endTime = p.next.time;
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
    const safe = this.clock.currentTime + SAFETY;
    const pos = tickAtTime(this.segs, safe) ?? { tick: this.cursor.tick, iter: this.cursor.iter };

    for (const n of [...this.notes.values()]) {
      if (n.startTime >= safe) {
        this.sink.noteOff(n.ev.channelId, { time: n.startTime, noteId: n.noteId, key: n.ev.pitch });
        this.notes.delete(n.noteId);
      }
    }

    // Drop the planned future; keep the past for the playhead.
    this.segs = this.segs.filter((s) => s.time0 < safe);
    const last = this.segs[this.segs.length - 1];
    if (last && segmentEndTime(last) > safe) this.segs[this.segs.length - 1] = { ...last, tick1: pos.tick };

    let tick = pos.tick;
    const L = timeline.loop;
    if (loopChanged && L && L.end > L.start && (tick >= L.end || tick < L.start)) {
      tick = L.start + ((((tick - L.start) % (L.end - L.start)) + (L.end - L.start)) % (L.end - L.start));
    }
    this.cursor = { tick, time: safe, iter: pos.iter };
    this.endTime = null;

    // Sounding notes: release ones whose source disappeared, follow length changes.
    const project = this.source.project;
    for (const n of [...this.notes.values()]) {
      if (n.offSent) continue;
      const ev = n.ev;
      const channel = project.channels[ev.channelId];
      let end: number | null = null;
      if (ev.kind === 'audio') {
        const clip = project.playlist.clips[ev.clipId as keyof typeof project.playlist.clips];
        // An edited clip (moved, trimmed…) restarts from the new model; an untouched one keeps playing,
        // unless its channel now plays it differently (pitch, reverse, tempo follow, another sample) or
        // the tempo changed under a clip that follows it.
        const same =
          clip?.kind === 'audio' &&
          clip.channelId === ev.channelId &&
          clip === n.clip &&
          channel?.kind === 'audioClip' &&
          playbackKey(channel) === n.audioKey &&
          !(tempoChanged && n.follows);
        if (same) end = clip.start + clip.length;
      } else if (ev.patternId && ev.noteId) {
        const note = project.patterns[ev.patternId]?.notes[ev.channelId]?.[ev.noteId];
        const clipGone =
          ev.clipId !== 'pattern' && !project.playlist.clips[ev.clipId as keyof typeof project.playlist.clips];
        if (note && !clipGone) end = Math.min(ev.start + note.length, ev.clipEnd);
      }
      if (end === null || !channel) {
        this.release(n, safe);
        continue;
      }
      n.endTick = end;
      if (n.iter === pos.iter && n.endTick <= tick) this.release(n, safe);
    }
    this.scanOngoing = true;
    for (const o of this.observers) o.reanchored?.(safe, timelineChanged);
    this.pump();
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
    const hit = tickAtTime(this.segs, time);
    if (hit) return hit.tick;
    return this.segs[0]?.tick0 ?? this.cursor?.tick ?? this.stoppedTick;
  }

  /** The loop iteration heard at `time` (UI uses it for the current step light). */
  iterationAt(time: number): number {
    return tickAtTime(this.segs, time)?.iter ?? 0;
  }

  private process(seg: Segment): void {
    const now = this.clock.currentTime;
    const events: NoteEvent[] = [];
    collectNotes(this.source, seg.tick0, seg.tick1, events);
    const L = this.timeline.loop;
    const tempo = this.timeline.tempo;
    // Audio clips also start mid-way after a start/seek/edit, or when the loop wraps into one, unless
    // their sample is still playing from before an edit.
    const wrapped = !!L && seg.iter > 0 && seg.tick0 === L.start;
    const scan = this.scanOngoing || wrapped;
    let sounding: Set<string> | undefined;
    if (scan) {
      sounding = new Set();
      for (const n of this.notes.values())
        if (n.ev.kind === 'audio' && !n.offSent && n.iter === seg.iter) sounding.add(n.ev.clipId);
    }
    collectAudio(this.source, seg.tick0, seg.tick1, events, scan ? seg.tick0 : null, tempo, sounding);
    this.scanOngoing = false;
    const clips = this.source.project?.playlist.clips;
    for (const ev of events) {
      const time = timeInSegment(seg, ev.start, tempo);
      if (time < now) this.lateEvents++;
      const noteId = ++this.noteSeq;
      const n: Scheduled = { ev, noteId, startTime: time, iter: seg.iter, endTick: ev.end, offSent: false };
      let audioClip: AudioClip | null = null;
      if (ev.kind === 'audio' && clips) {
        const clip = clips[ev.clipId as keyof typeof clips];
        const channel = this.source.project.channels[ev.channelId];
        if (clip) n.clip = clip;
        if (clip?.kind === 'audio') audioClip = clip;
        if (channel?.kind === 'audioClip') {
          n.audioKey = playbackKey(channel);
          n.follows = followsTempo(playbackMode(channel));
        }
      }
      this.notes.set(noteId, n);
      const on: NoteOn = {
        time,
        noteId,
        key: ev.pitch,
        velocity: ev.velocity,
        ...(ev.pan !== undefined ? { pan: ev.pan } : {}),
        ...(ev.fine !== undefined ? { fine: ev.fine } : {}),
        ...(ev.offsetSec !== undefined ? { offset: ev.offsetSec } : {}),
      };
      if (audioClip && this.sink.audioOn) this.sink.audioOn(ev.channelId, { ...on, clip: audioClip, tick: ev.start, tempo });
      else this.sink.noteOn(ev.channelId, on);
    }
    const atLoopEnd = !!L && seg.tick1 >= L.end - 1e-9;
    const atSongEnd = !L && seg.tick1 >= this.timeline.endTick - 1e-9;
    const segEnd = segmentEndTime(seg);
    for (const n of this.notes.values()) {
      if (n.offSent) continue;
      if (n.iter < seg.iter) this.release(n, seg.time0);
      else if (n.iter === seg.iter && n.endTick < seg.tick1) {
        this.release(n, Math.max(n.startTime, timeInSegment(seg, n.endTick, tempo)));
      } else if (n.iter === seg.iter && (atLoopEnd || atSongEnd)) this.release(n, segEnd);
    }
  }

  private release(n: Scheduled, time: number): void {
    n.offSent = true;
    // A release at the start time would cancel the note; nudge it just past the start.
    const t = time <= n.startTime ? n.startTime + 1e-4 : time;
    this.sink.noteOff(n.ev.channelId, {
      time: t,
      noteId: n.noteId,
      key: n.ev.pitch,
      ...(n.ev.release !== undefined ? { release: n.ev.release } : {}),
    });
  }

  private trim(): void {
    const now = this.clock.currentTime;
    for (const [id, n] of this.notes) if (n.offSent && n.startTime < now) this.notes.delete(id);
    const keepAfter = now - 2;
    let i = 0;
    while (i < this.segs.length - 1 && segmentEndTime(this.segs[i] as Segment) < keepAfter) i++;
    if (i > 0) this.segs.splice(0, i);
  }

  private reset(): void {
    this.notes.clear();
    this.segs = [];
    this.cursor = null;
  }
}
