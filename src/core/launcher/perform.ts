/**
 * "Record performance to playlist": writes what the launcher played (a `PerformanceTake`) onto the playlist at the
 * times it played, so a jam becomes an arrangement. One edit: the caller wraps it in one History transaction.
 */
import type { Draft } from 'immer';
import { sourceSecondsAt, playbackMode } from '../audio/playback';
import { newId } from '../model/ids';
import { makeLane } from '../model/defaults';
import { addClips, addLane } from '../ops/playlist';
import { constantTempo, type TempoMap } from '../time/ppq';
import type { AudioClip, Clip, ClipId, LaneId, LaunchTrackId, PatternClip, Project, Tick } from '../model/types';
import type { PerformanceEntry, PerformanceTake } from './sequencer';

/** What writing a performance take to the playlist changed: the new clips and the playlist tracks they went on. */
export interface WrittenPerformance {
  clips: ClipId[];
  /** Playlist tracks the clips went on (new ones included). */
  lanes: LaneId[];
  /** The span of the song they cover. */
  from: Tick;
  to: Tick;
}

/** The entries of a take by launcher track, in the order the tracks first appear. */
function entriesByTrack(take: PerformanceTake): Map<LaunchTrackId, PerformanceEntry[]> {
  const byTrack = new Map<LaunchTrackId, PerformanceEntry[]>();
  for (const e of take.entries) {
    const list = byTrack.get(e.trackId);
    if (list) list.push(e);
    else byTrack.set(e.trackId, [e]);
  }
  return byTrack;
}

/**
 * The playlist track a launcher track's entries go on: its own when it is free where the jam goes (over
 * [from, to)); else a new one named for the launcher track, so nothing is overwritten.
 */
function laneForTrack(
  d: Draft<Project>,
  trackId: LaunchTrackId,
  entries: readonly PerformanceEntry[],
  from: Tick,
  to: Tick,
): LaneId {
  const p = d as unknown as Project;
  const track = p.launcher?.tracks[trackId];
  const own: LaneId | undefined = track?.laneId && p.playlist.lanes[track.laneId] ? track.laneId : undefined;
  const isFree =
    own && !Object.values(p.playlist.clips).some((c) => c.laneId === own && c.start < to && c.start + c.length > from);
  if (own && isFree) return own;
  const made = makeLane(`Jam · ${track?.name ?? entries[0]?.name ?? 'Track'}`);
  addLane(d, made);
  return made.id;
}

/** The pattern clip for a pattern entry that starts at song tick `start`; it plays on from where the pattern was when the entry began (`phase`). */
function patternClipFor(e: PerformanceEntry, lane: LaneId, start: Tick, length: Tick): PatternClip {
  if (e.content.kind !== 'pattern') throw new Error('patternClipFor: the entry is not a pattern');
  return {
    id: newId.clip(),
    kind: 'pattern',
    laneId: lane,
    start,
    length,
    patternId: e.content.patternId,
    offset: Math.max(0, Math.round(e.phase)),
    ...(e.name ? { name: e.name } : {}),
    color: e.color,
  };
}

/** Audio: a loop is one clip per pass (a playlist audio clip does not repeat itself), the last one cut short. */
function audioClipsFor(p: Project, e: PerformanceEntry, lane: LaneId, offset: Tick, tempo: TempoMap): AudioClip[] {
  const content = e.content;
  if (content.kind !== 'audio') throw new Error('audioClipsFor: the entry is not audio');
  const channel = p.channels[content.channelId];
  const mode = playbackMode(channel?.kind === 'audioClip' ? (channel as never) : {});
  const pass = Math.max(1, e.passLength);
  const clips: AudioClip[] = [];
  let at = e.startU;
  let phase = e.phase % pass;
  while (at < e.endU - 0.5) {
    const len = Math.min(pass - phase, e.endU - at);
    const offsetSec =
      phase > 0 ? sourceSecondsAt({ start: 0, offsetSec: content.offsetSec }, mode, tempo, phase) : content.offsetSec;
    clips.push({
      id: newId.clip(),
      kind: 'audio',
      laneId: lane,
      start: Math.round(at + offset),
      length: Math.max(1, Math.round(len)),
      channelId: content.channelId,
      offsetSec,
      ...(content.gain !== undefined ? { gain: content.gain } : {}),
      ...(content.fadeIn !== undefined ? { fadeIn: content.fadeIn } : {}),
      ...(content.fadeOut !== undefined ? { fadeOut: content.fadeOut } : {}),
      ...(e.name ? { name: e.name } : {}),
      color: e.color,
    });
    at += len;
    phase = 0;
    if (!e.loop) break;
  }
  return clips;
}

/**
 * Writes a take onto the playlist: each launcher track's entries on one playlist track, each at its launcher time
 * plus `offset` ticks (the song position where the take's first tick goes).
 */
export function writePerformance(d: Draft<Project>, take: PerformanceTake, offset: Tick = 0): WrittenPerformance {
  const p = d as unknown as Project;
  const clips: Clip[] = [];
  const lanes: LaneId[] = [];
  let from = Infinity;
  let to = 0;
  const tempo = constantTempo(p.transport.bpm);
  for (const [trackId, entries] of entriesByTrack(take)) {
    const a = Math.min(...entries.map((e) => e.startU)) + offset;
    const b = Math.max(...entries.map((e) => e.endU)) + offset;
    const lane = laneForTrack(d, trackId, entries, a, b);
    lanes.push(lane);
    for (const e of entries) {
      const start = Math.round(e.startU + offset);
      const length = Math.max(1, Math.round(e.endU - e.startU));
      from = Math.min(from, start);
      to = Math.max(to, start + length);
      if (e.content.kind === 'pattern') clips.push(patternClipFor(e, lane, start, length));
      else clips.push(...audioClipsFor(p, e, lane, offset, tempo));
    }
  }
  addClips(d, clips);
  return { clips: clips.map((c) => c.id), lanes, from: Number.isFinite(from) ? from : 0, to };
}
