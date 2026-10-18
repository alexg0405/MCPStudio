/**
 * The clip launcher's events: what its runs play in a span of the launcher axis `u` (core/launcher/run.ts).
 * Pure, shares the note semantics with the song through `collectNotes`. Event times are on `u`; the transport
 * maps them to the audio clock through the segment they fall in.
 */
import type { AudioClip, ChannelId, ClipId, LaneId, Project } from '@core/model/types';
import type { LaunchRun } from '@core/launcher/run';
import { effectivelyMuted } from '@core/query/queries';
import { collectNotes, type NoteEvent, type PlayClip } from './events';

/** A run that never ends by itself is this long as far as the collector is concerned. */
const OPEN = 2 ** 40;

export const launchClipId = (run: LaunchRun) => `launch:${run.id}`;

/** Notes of the pattern runs that start in [from, to). */
export function collectLaunchNotes(project: Project, runs: readonly LaunchRun[], from: number, to: number, out: NoteEvent[]): void {
  const clips: PlayClip[] = [];
  for (const r of runs) {
    if (r.content.kind !== 'pattern') continue;
    const end = r.endU ?? OPEN;
    if (end <= from || r.startU >= to) continue;
    clips.push({ clipId: launchClipId(r), patternId: r.content.patternId, start: r.startU, length: end - r.startU, offset: 0 });
  }
  if (!clips.length) return;
  const first = out.length;
  collectNotes({ project, clips }, from, to, out);
  for (let i = first; i < out.length; i++) {
    const ev = out[i] as NoteEvent;
    ev.launch = { runId: ev.clipId.slice('launch:'.length) };
  }
}

/** The clip a pass of an audio run plays (what the clip player needs: its start, length, gain and fades). */
function passClip(r: LaunchRun, start: number, pass: number): AudioClip {
  const c = r.content;
  if (c.kind !== 'audio') throw new Error('not an audio run');
  return {
    id: `launch:${r.id}:${Math.round((start - r.startU) / pass)}` as ClipId,
    laneId: 'launch' as LaneId,
    kind: 'audio',
    start,
    length: pass,
    channelId: c.channelId,
    offsetSec: c.offsetSec,
    ...(c.gain !== undefined ? { gain: c.gain } : {}),
    ...(c.fadeIn !== undefined ? { fadeIn: c.fadeIn } : {}),
    ...(c.fadeOut !== undefined ? { fadeOut: c.fadeOut } : {}),
  };
}

/**
 * Audio passes starting in [from, to). With `ongoingAt`, also passes already playing at that tick (the plan was made
 * again, or playback jumped): they start inside the sample, unless their sample is already sounding (`sounding`
 * holds the clip ids of those).
 */
export function collectLaunchAudio(
  project: Project,
  runs: readonly LaunchRun[],
  from: number,
  to: number,
  out: NoteEvent[],
  ongoingAt: number | null,
  sounding?: ReadonlySet<string>,
): void {
  let muted: ReadonlySet<ChannelId> | null = null;
  for (const r of runs) {
    const c = r.content;
    if (c.kind !== 'audio' || r.passLength <= 0) continue;
    const runEnd = r.endU ?? OPEN;
    if (runEnd <= from && (ongoingAt === null || runEnd <= ongoingAt)) continue;
    if (r.startU >= to) continue;
    if (project.channels[c.channelId]?.kind !== 'audioClip') continue;
    muted ??= effectivelyMuted(project.channels);
    if (muted.has(c.channelId)) continue;
    // The passes that can matter: the one playing at `from` (for a mid-way start) up to the last one starting before `to`.
    const first = Math.max(0, Math.floor((Math.min(from, ongoingAt ?? from) - r.startU) / r.passLength));
    const last = r.loop ? Math.floor((Math.min(to, runEnd) - 1e-9 - r.startU) / r.passLength) : 0;
    for (let k = first; k <= last; k++) {
      const start = r.startU + k * r.passLength;
      const passEnd = Math.min(start + r.passLength, runEnd);
      if (start >= runEnd) break;
      const clip = passClip(r, start, r.passLength);
      let at: number | null = null;
      if (start >= from && start < to) at = start;
      else if (ongoingAt !== null && start < ongoingAt && ongoingAt < passEnd && ongoingAt >= from && ongoingAt < to && !sounding?.has(clip.id))
        at = ongoingAt;
      if (at === null) continue;
      out.push({
        kind: 'audio',
        key: `${clip.id}:audio`,
        clipId: clip.id,
        channelId: c.channelId,
        patternId: null,
        noteId: null,
        clipEnd: passEnd,
        rawStart: at,
        start: at,
        end: passEnd,
        pitch: 60,
        velocity: 1,
        offsetSec: c.offsetSec,
        launch: { runId: r.id, clip },
      });
    }
  }
}

/** Positions on the axis come out of sums of fractional ticks: compare within a millionth of a tick. */
const EPS = 1e-6;

/** True while a run of the lane takes it over at `u`. */
export function laneOverridden(runs: readonly LaunchRun[], laneId: LaneId, u: number): boolean {
  for (const r of runs) if (r.laneId === laneId && r.startU <= u + EPS && (r.endU === null || u < r.endU - EPS)) return true;
  return false;
}

/** The tick a run of the lane starts taking it over at, after `u` (null when none does). */
export function overrideStartAfter(runs: readonly LaunchRun[], laneId: LaneId, u: number): number | null {
  let hit: number | null = null;
  for (const r of runs) if (r.laneId === laneId && r.startU > u + EPS && (hit === null || r.startU < hit)) hit = r.startU;
  return hit;
}
