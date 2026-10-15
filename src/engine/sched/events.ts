/**
 * Turns the project into note events for a tick range. Pure; shares semantics with the UI through
 * core/query (pattern length, sorted notes, effective mute).
 */
import type { ChannelId, NoteId, PatternId, Project, Tick } from '@core/model/types';
import { effectivelyMuted, lowerBound, notesSorted, patternLength } from '@core/query/queries';
import { audibleClips, songLength } from '@core/query/playlist';
import type { TempoMap } from '@core/time/ppq';
import { swingDelay } from '@core/time/swing';

/** A pattern placed on the timeline: a playlist clip, or the virtual clip used in pattern mode. */
export interface PlayClip {
  clipId: string;
  patternId: PatternId;
  start: Tick;
  length: Tick;
  offset: Tick;
}

/** An audio clip placed on the timeline (plays its channel's sample). */
export interface AudioPlayClip {
  clipId: string;
  channelId: ChannelId;
  start: Tick;
  length: Tick;
  /** Trim into the sample, in seconds. */
  offsetSec: number;
}

export interface NoteEvent {
  /** 'audio' events start an audio clip's sample (pitch/velocity unused). */
  kind: 'note' | 'audio';
  /** Identity within one loop iteration: clip, source note and pattern repetition. */
  key: string;
  clipId: string;
  channelId: ChannelId;
  patternId: PatternId | null;
  noteId: NoteId | null;
  /** End of the clip the note plays in (notes are cut there). */
  clipEnd: number;
  /** Unswung absolute start. */
  rawStart: number;
  /** Absolute ticks (start may be fractional when swing is applied). */
  start: number;
  end: number;
  pitch: number;
  velocity: number;
  pan?: number;
  /** Fine pitch in cents. */
  fine?: number;
  /** Release velocity 0–1. */
  release?: number;
  /** Seconds into the sound to start at (audio clips, or starting playback inside one). */
  offsetSec?: number;
}

export interface EventSource {
  project: Project;
  clips: readonly PlayClip[];
  audio?: readonly AudioPlayClip[];
}

/** Song mode: every audible playlist clip; the song is as long as its last clip (whole bars). */
export function songModeSource(project: Project): { source: EventSource; length: Tick } {
  const clips: PlayClip[] = [];
  const audio: AudioPlayClip[] = [];
  for (const c of audibleClips(project)) {
    if (c.kind === 'pattern')
      clips.push({ clipId: c.id, patternId: c.patternId, start: c.start, length: c.length, offset: c.offset });
    else if (c.kind === 'audio')
      audio.push({ clipId: c.id, channelId: c.channelId, start: c.start, length: c.length, offsetSec: c.offsetSec });
  }
  return { source: { project, clips, audio }, length: songLength(project) };
}

/**
 * Audio clips starting in [from, to). With `ongoingAt`, also clips already playing at that tick
 * (playback started or looped into the middle of a clip): they start mid-sample.
 */
export function collectAudio(
  source: EventSource,
  from: number,
  to: number,
  out: NoteEvent[],
  ongoingAt: number | null,
  tempo: TempoMap,
  /** Clips whose sample is already playing (not started again mid-way). */
  sounding?: ReadonlySet<string>,
): void {
  if (!source.audio?.length) return;
  const muted = effectivelyMuted(source.project.channels);
  for (const c of source.audio) {
    if (muted.has(c.channelId) || source.project.channels[c.channelId]?.kind !== 'audioClip') continue;
    const end = c.start + c.length;
    let at: number;
    let offsetSec = c.offsetSec;
    if (c.start >= from && c.start < to) at = c.start;
    else if (
      ongoingAt !== null &&
      c.start < ongoingAt &&
      ongoingAt < end &&
      ongoingAt >= from &&
      ongoingAt < to &&
      !sounding?.has(c.clipId)
    ) {
      at = ongoingAt;
      offsetSec += tempo.tickToSeconds(ongoingAt) - tempo.tickToSeconds(c.start);
    } else continue;
    out.push({
      kind: 'audio',
      key: `${c.clipId}:audio`,
      clipId: c.clipId,
      channelId: c.channelId,
      patternId: null,
      noteId: null,
      clipEnd: end,
      rawStart: at,
      start: at,
      end,
      pitch: 60,
      velocity: 1,
      offsetSec,
    });
  }
}

/** Pattern mode: the selected pattern as a clip at 0 spanning its own length. */
export function patternModeSource(
  project: Project,
  patternId: PatternId | null,
): { source: EventSource; length: Tick } {
  const pattern = patternId ? project.patterns[patternId] : undefined;
  if (!pattern) return { source: { project, clips: [] }, length: patternLengthOrBar(project) };
  const length = patternLength(pattern, project.transport.timeSig);
  return {
    source: { project, clips: [{ clipId: 'pattern', patternId: pattern.id, start: 0, length, offset: 0 }] },
    length,
  };
}

function patternLengthOrBar(project: Project): Tick {
  const ts = project.transport.timeSig;
  return (ts.num * 4 * 960) / ts.den;
}

/**
 * Collects note events whose (unswung) start is in [from, to). Appends to `out`. Swing follows the
 * curve in `core/time/swing.ts` on each note's position in its pattern; a note keeps its length.
 */
export function collectNotes(source: EventSource, from: number, to: number, out: NoteEvent[]): void {
  const { project } = source;
  const muted = effectivelyMuted(project.channels);
  const swing = project.transport.swing;
  for (const clip of source.clips) {
    const clipEnd = clip.start + clip.length;
    const a = Math.max(from, clip.start);
    const b = Math.min(to, clipEnd);
    if (b <= a) continue;
    const pattern = project.patterns[clip.patternId];
    if (!pattern) continue;
    const P = patternLength(pattern, project.transport.timeSig);
    // Clip-local [a,b) → content positions, repeating every P ticks.
    const la = a - clip.start + clip.offset;
    const lb = b - clip.start + clip.offset;
    const firstRep = Math.floor(la / P);
    const lastRep = Math.floor((lb - 1e-9) / P);
    for (const cid in pattern.notes) {
      const channelId = cid as ChannelId;
      const ch = project.channels[channelId];
      if (!ch || ch.kind !== 'instrument' || muted.has(channelId)) continue;
      const notes = notesSorted(pattern.notes[channelId]);
      if (notes.length === 0) continue;
      for (let rep = firstRep; rep <= lastRep; rep++) {
        const c0 = Math.max(la - rep * P, 0);
        const c1 = Math.min(lb - rep * P, P);
        for (let i = lowerBound(notes, Math.ceil(c0)); i < notes.length; i++) {
          const n = notes[i];
          if (!n || n.tick >= c1) break;
          if (n.muted) continue;
          const start = clip.start - clip.offset + rep * P + n.tick;
          if (start < clip.start) continue;
          const swung = start + swingDelay(n.tick, swing);
          out.push({
            kind: 'note',
            key: `${clip.clipId}:${n.id}:${rep}`,
            clipId: clip.clipId,
            channelId,
            patternId: clip.patternId,
            noteId: n.id,
            clipEnd,
            rawStart: start,
            start: swung,
            end: Math.min(swung + n.length, clipEnd),
            pitch: n.key,
            velocity: n.velocity,
            ...(n.pan !== undefined ? { pan: n.pan } : {}),
            ...(n.fine !== undefined ? { fine: n.fine } : {}),
            ...(n.release !== undefined ? { release: n.release } : {}),
          });
        }
      }
    }
  }
}
