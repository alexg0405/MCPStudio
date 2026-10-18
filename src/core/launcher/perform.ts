/**
 * "Record performance to playlist": writes what the launcher played (a `PerformanceTake`) onto the playlist at the
 * times it played, so a jam becomes an arrangement. One edit: the caller wraps it in one History transaction.
 */
import type { Draft } from 'immer';
import { sourceSecondsAt, playbackMode } from '../audio/playback';
import { newId } from '../model/ids';
import { makeLane } from '../model/defaults';
import { addClips, addLane } from '../ops/playlist';
import { constantTempo } from '../time/ppq';
import type { Clip, ClipId, LaneId, LaunchTrackId, Project, Tick } from '../model/types';
import type { PerformanceEntry, PerformanceTake } from './sequencer';

export interface WrittenPerformance {
  clips: ClipId[];
  /** Playlist tracks the clips went on (new ones included). */
  lanes: LaneId[];
  /** The span of the song they cover. */
  from: Tick;
  to: Tick;
}

/** Where on the song a take starts when written (its first launcher tick), plus `offset`. */
export function writePerformance(d: Draft<Project>, take: PerformanceTake, offset: Tick = 0): WrittenPerformance {
  const p = d as unknown as Project;
  const byTrack = new Map<LaunchTrackId, PerformanceEntry[]>();
  for (const e of take.entries) {
    const list = byTrack.get(e.trackId);
    if (list) list.push(e);
    else byTrack.set(e.trackId, [e]);
  }
  const clips: Clip[] = [];
  const lanes: LaneId[] = [];
  let from = Infinity;
  let to = 0;
  const tempo = constantTempo(p.transport.bpm);
  for (const [trackId, entries] of byTrack) {
    const track = p.launcher?.tracks[trackId];
    const a = Math.min(...entries.map((e) => e.startU)) + offset;
    const b = Math.max(...entries.map((e) => e.endU)) + offset;
    // The track's own playlist track when it is free where the jam goes; else a new one, so nothing is overwritten.
    let lane: LaneId | undefined = track?.laneId && p.playlist.lanes[track.laneId] ? track.laneId : undefined;
    if (lane && Object.values(p.playlist.clips).some((c) => c.laneId === lane && c.start < b && c.start + c.length > a)) lane = undefined;
    if (!lane) {
      const made = makeLane(`Jam · ${track?.name ?? entries[0]?.name ?? 'Track'}`);
      addLane(d, made);
      lane = made.id;
    }
    lanes.push(lane);
    for (const e of entries) {
      const start = Math.round(e.startU + offset);
      const length = Math.max(1, Math.round(e.endU - e.startU));
      from = Math.min(from, start);
      to = Math.max(to, start + length);
      if (e.content.kind === 'pattern') {
        clips.push({
          id: newId.clip(),
          kind: 'pattern',
          laneId: lane,
          start,
          length,
          patternId: e.content.patternId,
          offset: Math.max(0, Math.round(e.phase)),
          ...(e.name ? { name: e.name } : {}),
          color: e.color,
        });
        continue;
      }
      // Audio: a loop is one clip per pass (a playlist audio clip does not repeat itself).
      const c = e.content;
      const mode = playbackMode(p.channels[c.channelId]?.kind === 'audioClip' ? (p.channels[c.channelId] as never) : {});
      const pass = Math.max(1, e.passLength);
      let at = e.startU;
      let phase = e.phase % pass;
      while (at < e.endU - 0.5) {
        const len = Math.min(pass - phase, e.endU - at);
        const offsetSec = phase > 0 ? sourceSecondsAt({ start: 0, offsetSec: c.offsetSec }, mode, tempo, phase) : c.offsetSec;
        clips.push({
          id: newId.clip(),
          kind: 'audio',
          laneId: lane,
          start: Math.round(at + offset),
          length: Math.max(1, Math.round(len)),
          channelId: c.channelId,
          offsetSec,
          ...(c.gain !== undefined ? { gain: c.gain } : {}),
          ...(c.fadeIn !== undefined ? { fadeIn: c.fadeIn } : {}),
          ...(c.fadeOut !== undefined ? { fadeOut: c.fadeOut } : {}),
          ...(e.name ? { name: e.name } : {}),
          color: e.color,
        });
        at += len;
        phase = 0;
        if (!e.loop) break;
      }
    }
  }
  addClips(d, clips);
  return { clips: clips.map((c) => c.id), lanes, from: Number.isFinite(from) ? from : 0, to };
}
