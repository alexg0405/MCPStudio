/**
 * What a live edit does to the notes that are already sounding (or about to): the decisions of a re-plan, kept apart
 * from the transport's bookkeeping. A note is kept, shortened, lengthened or released depending on whether its source
 * (pattern note, playlist clip, launcher run) is still there and still plays the same way.
 */
import type { Project, Tick } from '@core/model/types';
import { playbackKey } from '@core/audio/playback';
import type { LaunchRun } from '@core/launcher/run';
import type { Timeline } from './core';
import type { EventSource, NoteEvent } from './events';
import { fxNoteEnd } from './fx-events';
import type { Scheduled } from './plan-state';

/** Rounding slack when comparing positions on the launcher axis (ticks). */
const U_EPSILON = 1e-6;

/** What reviseSoundingNotes does to a note: the transport's own bookkeeping. */
export interface ReviseHost {
  /** The model being played after the edit. */
  readonly source: EventSource;
  /** Sends the note's release at `time` (and remembers it was sent). */
  release(scheduled: Scheduled, time: number): void;
  /** Cancels a note that has not begun: its release at its own start time. */
  silence(scheduled: Scheduled): void;
  /** The context time of launcher tick `u` on the planned segments (null before the first one). */
  timeAtU(u: number): number | null;
}

/** Where the re-plan starts and what changed (the clock, the safe time, the position, the tempo). */
export interface ReviseAt {
  now: number;
  /** The first time the audio thread has not reached yet (now plus a safety margin). */
  safe: number;
  /** The launcher axis position at `safe`. */
  uPosition: number;
  /** The song tick and loop pass at `safe`. */
  tick: Tick;
  iter: number;
  tempoChanged: boolean;
}

/** A new loop region may leave the position outside it: the position wraps into the loop as playback would. */
export function wrapIntoLoop(tick: Tick, loop: Timeline['loop']): Tick {
  if (!loop || loop.end <= loop.start || (tick >= loop.start && tick < loop.end)) return tick;
  const length = loop.end - loop.start;
  return loop.start + ((((tick - loop.start) % length) + length) % length);
}

/**
 * Runs that start before the new cursor and were never planned (they were launched on a boundary a few ms ago), with
 * the earliest of their starts; null when there are none. `launchDone` holds the ids of the runs the planner passed.
 */
export function runsToCatchUp(
  source: EventSource,
  uPosition: number,
  launchDone: ReadonlySet<string>,
): { runs: LaunchRun[]; from: number } | null {
  const late = source.launch?.runs.filter(
    (run) => run.startU < uPosition - U_EPSILON && !launchDone.has(run.id) && run.content.kind === 'pattern',
  );
  if (!late || late.length === 0) return null;
  return { runs: late, from: Math.min(...late.map((run) => run.startU)) };
}

/** Sounding notes after a re-plan: release those whose source disappeared, follow length changes. */
export function reviseSoundingNotes(host: ReviseHost, notes: readonly Scheduled[], at: ReviseAt): void {
  const project = host.source.project;
  for (const scheduled of notes) {
    if (scheduled.offSent) continue;
    const ev = scheduled.ev;
    const channel = project.channels[ev.channelId];
    if (ev.launch) {
      reviseLauncherNote(host, scheduled, project, at);
      continue;
    }
    const end = noteEndAfterEdit(host, scheduled, at);
    if (end === null || !channel) {
      host.release(scheduled, at.safe);
      continue;
    }
    scheduled.endTick = end;
    if (scheduled.iter === at.iter && scheduled.endTick <= at.tick) host.release(scheduled, at.safe);
  }
}

/** Where a sounding note of the song ends after an edit, or null when it must be released: an audio clip, a note the effects made, or a pattern note. */
function noteEndAfterEdit(host: ReviseHost, scheduled: Scheduled, at: ReviseAt): Tick | null {
  const ev = scheduled.ev;
  if (ev.kind === 'audio') return audioClipEnd(scheduled, host.source.project, at.tempoChanged);
  if (ev.fx !== undefined) return fxNoteEnd(host.source, ev);
  return patternNoteEnd(ev, host.source.project);
}

/**
 * A launcher note goes on while its run does (a cut run ends its notes at the cut): releases it when its run, its
 * channel or its note is gone, silences one whose run was cut before it began, and follows length changes.
 */
function reviseLauncherNote(host: ReviseHost, scheduled: Scheduled, project: Project, at: ReviseAt): void {
  const ev = scheduled.ev;
  const channel = project.channels[ev.channelId];
  const run = host.source.launch?.runs.find((r) => r.id === ev.launch?.runId);
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
    host.release(scheduled, at.safe);
    return;
  }
  if (scheduled.startTime >= at.now && ev.start >= runEnd) {
    // Its run was cut before it began (a stop or replacement on a boundary a moment ago): it never sounds.
    host.silence(scheduled);
    return;
  }
  const note =
    ev.kind === 'note' && ev.patternId && ev.noteId ? project.patterns[ev.patternId]?.notes[ev.channelId]?.[ev.noteId] : undefined;
  scheduled.endU = Math.min(note ? ev.start + note.length : ev.end, runEnd);
  // Ended already: at its own end when that is still ahead of the clock (a cut a few ms ago), else now.
  if (scheduled.endU <= at.uPosition) {
    host.release(scheduled, Math.min(at.safe, Math.max(scheduled.startTime, host.timeAtU(scheduled.endU) ?? at.safe)));
  }
}

/**
 * Where a sounding audio clip note ends after an edit, or null when it must be released. An edited clip (moved,
 * trimmed…) restarts from the new model; an untouched one keeps playing, unless its channel now plays it differently
 * (pitch, reverse, tempo follow, another sample) or the tempo changed under a clip that follows it.
 */
function audioClipEnd(scheduled: Scheduled, project: Project, tempoChanged: boolean): Tick | null {
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
function patternNoteEnd(ev: NoteEvent, project: Project): Tick | null {
  if (!ev.patternId || !ev.noteId) return null;
  const note = project.patterns[ev.patternId]?.notes[ev.channelId]?.[ev.noteId];
  const clipGone = ev.clipId !== 'pattern' && !project.playlist.clips[ev.clipId as keyof typeof project.playlist.clips];
  return note && !clipGone ? Math.min(ev.start + note.length, ev.clipEnd) : null;
}
