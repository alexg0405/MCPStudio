/**
 * Turns the project into note events for a tick range. Pure; shares semantics with the UI through
 * core/query (pattern length, sorted notes, effective mute).
 */
import type { AudioClip, ChannelId, InstrumentChannel, Note, NoteId, Pattern, PatternId, Project, Tick } from '@core/model/types';
import type { LaunchRun } from '@core/launcher/run';
import { effectivelyMuted, lowerBound, notesSorted, patternLength } from '@core/query/queries';
import { audibleClips, songLength } from '@core/query/playlist';
import { PPQ, type TempoMap } from '@core/time/ppq';
import { swingDelay } from '@core/time/swing';
import { collectFxNotes, hasActiveFx } from './fx-events';

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

/** A note (or an audio clip start) the transport will send to a channel, with its times in ticks. */
export interface NoteEvent {
  /** 'audio' events start an audio clip's sample (pitch/velocity unused). */
  kind: 'note' | 'audio';
  /** Identity within one loop iteration: clip, source note and pattern repetition. */
  key: string;
  clipId: string;
  channelId: ChannelId;
  patternId: PatternId | null;
  noteId: NoteId | null;
  /**
   * Set on a note the channel's MIDI effects made (it has no `noteId`): its identity within the effect chain's output, the same
   * every time the same notes are evaluated, so a re-plan can tell whether the chain still makes it.
   */
  fx?: string;
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
  /**
   * Set on events the clip launcher made: their times are on the launcher axis `u` (see core/launcher/run.ts),
   * not song ticks. Audio events carry the clip they play (a pass of the slot's audio, starting at `start`).
   */
  launch?: { runId: string; clip?: AudioClip };
}

/** What the transport plays: the project, the clips to play and what the launcher adds. */
export interface EventSource {
  project: Project;
  /** The tempo the transport plays under, for effects that think in milliseconds (the project's own tempo when absent). */
  tempo?: TempoMap;
  /** Song mode follows automation clips (MIDI effect knobs too); pattern mode plays the pattern alone. Absent = pattern mode. */
  mode?: 'song' | 'pattern';
  clips: readonly PlayClip[];
  audio?: readonly AudioPlayClip[];
  /** What the clip launcher plays on top of the song (see `launch.ts`). */
  launch?: { runs: readonly LaunchRun[] };
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
  return { source: { project, mode: 'song', clips, audio }, length: songLength(project) };
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
  if (!pattern) return { source: { project, mode: 'pattern', clips: [] }, length: patternLengthOrBar(project) };
  const length = patternLength(pattern, project.transport.timeSig);
  return {
    source: { project, mode: 'pattern', clips: [{ clipId: 'pattern', patternId: pattern.id, start: 0, length, offset: 0 }] },
    length,
  };
}

/** One bar of the project's time signature, in ticks (the length of "no pattern": an empty loop). */
function patternLengthOrBar(project: Project): Tick {
  const { num, den } = project.transport.timeSig;
  const quarterNotesPerWhole = 4;
  return (num * quarterNotesPerWhole * PPQ) / den;
}

/** Rounding slack when deciding which repetition of a pattern the end of a span falls in (ticks). */
const REPETITION_EPSILON = 1e-9;

/**
 * Collects note events whose (unswung) start is in [from, to). Appends to `out`. Swing follows the
 * curve in `core/time/swing.ts` on each note's position in its pattern; a note keeps its length.
 */
export function collectNotes(source: EventSource, from: number, to: number, out: NoteEvent[]): void {
  const { project } = source;
  const muted = effectivelyMuted(project.channels);
  for (const clip of source.clips) {
    const clipEnd = clip.start + clip.length;
    const spanStart = Math.max(from, clip.start);
    const spanEnd = Math.min(to, clipEnd);
    if (spanEnd <= spanStart) continue;
    const pattern = project.patterns[clip.patternId];
    if (!pattern) continue;
    collectClipNotes(source, clip, pattern, muted, spanStart, spanEnd, out);
  }
}

/** The notes of one pattern clip whose start falls in [spanStart, spanEnd) (a part of the clip), for every instrument channel. */
function collectClipNotes(
  source: EventSource,
  clip: PlayClip,
  pattern: Pattern,
  muted: ReadonlySet<ChannelId>,
  spanStart: number,
  spanEnd: number,
  out: NoteEvent[],
): void {
  const project = source.project;
  const patternTicks = patternLength(pattern, project.transport.timeSig);
  // Clip-local [spanStart, spanEnd) → content positions, repeating every patternTicks ticks.
  const contentStart = spanStart - clip.start + clip.offset;
  const contentEnd = spanEnd - clip.start + clip.offset;
  const firstRepetition = Math.floor(contentStart / patternTicks);
  const lastRepetition = Math.floor((contentEnd - REPETITION_EPSILON) / patternTicks);
  for (const channelKey in pattern.notes) {
    const channelId = channelKey as ChannelId;
    const channel = project.channels[channelId];
    if (!channel || channel.kind !== 'instrument' || muted.has(channelId)) continue;
    const notes = notesSorted(pattern.notes[channelId]);
    if (notes.length === 0) continue;
    if (hasActiveFx(channel)) {
      collectFxNotes(source, clip, pattern, channel as InstrumentChannel, spanStart, spanEnd, out);
      continue;
    }
    for (let repetition = firstRepetition; repetition <= lastRepetition; repetition++) {
      const from = Math.max(contentStart - repetition * patternTicks, 0);
      const to = Math.min(contentEnd - repetition * patternTicks, patternTicks);
      collectRepetition(project, clip, channelId, notes, repetition, patternTicks, from, to, out);
    }
  }
}

/** The notes of one channel in one repetition of the pattern whose tick is in [from, to), as events. */
function collectRepetition(
  project: Project,
  clip: PlayClip,
  channelId: ChannelId,
  notes: readonly Note[],
  repetition: number,
  patternTicks: number,
  from: number,
  to: number,
  out: NoteEvent[],
): void {
  const clipEnd = clip.start + clip.length;
  const swing = project.transport.swing;
  for (let i = lowerBound(notes, Math.ceil(from)); i < notes.length; i++) {
    const note = notes[i];
    if (!note || note.tick >= to) break;
    if (note.muted) continue;
    const start = clip.start - clip.offset + repetition * patternTicks + note.tick;
    if (start < clip.start) continue;
    const swung = start + swingDelay(note.tick, swing);
    out.push({
      kind: 'note',
      key: `${clip.clipId}:${note.id}:${repetition}`,
      clipId: clip.clipId,
      channelId,
      patternId: clip.patternId,
      noteId: note.id,
      clipEnd,
      rawStart: start,
      start: swung,
      end: Math.min(swung + note.length, clipEnd),
      pitch: note.key,
      velocity: note.velocity,
      ...(note.pan !== undefined ? { pan: note.pan } : {}),
      ...(note.fine !== undefined ? { fine: note.fine } : {}),
      ...(note.release !== undefined ? { release: note.release } : {}),
    });
  }
}
