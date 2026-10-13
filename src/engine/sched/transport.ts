/**
 * Lookahead transport: turns the pure plan()/collectNotes() core into timed noteOn/noteOff calls.
 * It knows nothing about Web Audio beyond a clock, so it runs the same against a realtime context,
 * an OfflineAudioContext (export) or a fake clock in tests.
 *
 * Live edits re-anchor: every not-yet-started note is cancelled (noteOff at its own start time
 * cancels it), planning restarts 10 ms from now with the new model, and sounding notes whose
 * source was deleted are released.
 */
import type { ChannelId, Tick } from '@core/model/types';
import type { NoteOff, NoteOn } from '@agstudio/sdk';
import { plan, segmentEndTime, tickAtTime, type Cursor, type Segment, type Timeline } from './core';
import { collectAudio, collectNotes, type EventSource, type NoteEvent } from './events';

export interface TransportSink {
  noteOn(channelId: ChannelId, e: NoteOn): void;
  noteOff(channelId: ChannelId, e: NoteOff): void;
  allNotesOff(time: number): void;
}

export interface Clock {
  readonly currentTime: number;
}

interface Scheduled {
  ev: NoteEvent;
  noteId: number;
  startTime: number;
  iter: number;
  /** Absolute end tick (may change on live edits). */
  endTick: number;
  offSent: boolean;
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
    this.pump();
  }

  /** Stops playback; FL returns the playhead to the start. */
  stop(returnTo: Tick = 0): void {
    if (this.playingFlag) this.sink.allNotesOff(this.clock.currentTime);
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
    for (const seg of p.segs) {
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
    const timelineChanged =
      timeline.spt !== this.timeline.spt ||
      timeline.endTick !== this.timeline.endTick ||
      timeline.loop?.start !== this.timeline.loop?.start ||
      timeline.loop?.end !== this.timeline.loop?.end;
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
    if (timelineChanged && L && L.end > L.start && (tick >= L.end || tick < L.start)) {
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
        if (clip?.kind === 'audio' && clip.channelId === ev.channelId) end = clip.start + clip.length;
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
    this.pump();
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
    // Audio clips also start mid-way after a start/seek/edit, or when the loop wraps into one.
    const wrapped = !!L && seg.iter > 0 && seg.tick0 === L.start;
    collectAudio(this.source, seg.tick0, seg.tick1, events, this.scanOngoing || wrapped ? seg.tick0 : null, seg.spt);
    this.scanOngoing = false;
    for (const ev of events) {
      const time = seg.time0 + (ev.start - seg.tick0) * seg.spt;
      if (time < now) this.lateEvents++;
      const noteId = ++this.noteSeq;
      const n: Scheduled = { ev, noteId, startTime: time, iter: seg.iter, endTick: ev.end, offSent: false };
      this.notes.set(noteId, n);
      this.sink.noteOn(ev.channelId, {
        time,
        noteId,
        key: ev.pitch,
        velocity: ev.velocity,
        ...(ev.pan !== undefined ? { pan: ev.pan } : {}),
        ...(ev.offsetSec !== undefined ? { offset: ev.offsetSec } : {}),
      });
    }
    const atLoopEnd = !!L && seg.tick1 >= L.end - 1e-9;
    const atSongEnd = !L && seg.tick1 >= this.timeline.endTick - 1e-9;
    const segEnd = segmentEndTime(seg);
    for (const n of this.notes.values()) {
      if (n.offSent) continue;
      if (n.iter < seg.iter) this.release(n, seg.time0);
      else if (n.iter === seg.iter && n.endTick < seg.tick1) {
        this.release(n, Math.max(n.startTime, seg.time0 + (n.endTick - seg.tick0) * seg.spt));
      } else if (n.iter === seg.iter && (atLoopEnd || atSongEnd)) this.release(n, segEnd);
    }
  }

  private release(n: Scheduled, time: number): void {
    n.offSent = true;
    // A release at the start time would cancel the note; nudge it just past the start.
    const t = time <= n.startTime ? n.startTime + 1e-4 : time;
    this.sink.noteOff(n.ev.channelId, { time: t, noteId: n.noteId, key: n.ev.pitch });
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
