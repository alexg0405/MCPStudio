/**
 * Playlist markers as user actions (named song positions: "Verse", "Drop"): add, rename, move,
 * delete, jump, loop to the next one. Each edit is one undo step. Markers are found by id, by
 * name (case-insensitive) or by number (1 = the first by position), so menus, the action search
 * and the AI all use the same functions.
 */
import type { Marker, MarkerId, Tick } from '@core/model/types';
import { addMarker, markersSorted, moveMarker, removeMarker, renameMarker } from '@core/ops/markers';
import { songLength } from '@core/query/playlist';
import { formatBST, ticksPerBar } from '@core/time/ppq';
import type { Services } from '../services';

/** A marker by id, name or number (1-based, in song order); null when nothing matches. */
export function findMarker(s: Services, ref: unknown): Marker | null {
  const p = s.doc.getState().project;
  const sorted = markersSorted(p);
  if (typeof ref === 'number' && Number.isInteger(ref)) return sorted[ref - 1] ?? null;
  if (typeof ref !== 'string') return null;
  const byId = p.playlist.markers[ref as MarkerId];
  if (byId) return byId;
  const want = ref.trim().toLowerCase();
  return sorted.find((m) => m.name.toLowerCase() === want) ?? sorted.find((m) => m.name.toLowerCase().startsWith(want)) ?? null;
}

/** The song position: where playback is heard while playing, else the song position marker. */
export function songPosition(s: Services): Tick {
  return s.engine.playing && s.view.getState().mode === 'song'
    ? Math.max(0, Math.round(s.engine.playhead()))
    : s.view.getState().songStart;
}

function nextMarkerName(s: Services): string {
  const names = new Set(Object.values(s.doc.getState().project.playlist.markers).map((m) => m.name));
  for (let i = 1; ; i++) if (!names.has(`Marker ${i}`)) return `Marker ${i}`;
}

/** Adds a marker (at the song position unless `tick` is given); returns its id. */
export function addMarkerAt(s: Services, tick: Tick = songPosition(s), name?: string): MarkerId {
  const label = name?.trim() || nextMarkerName(s);
  let id = '' as MarkerId;
  s.history.transact(`Add marker ‘${label}’`, (d) => {
    id = addMarker(d, tick, label);
  });
  return id;
}

export function renameMarkerTo(s: Services, id: MarkerId, name: string): void {
  const m = s.doc.getState().project.playlist.markers[id];
  if (!m || !name.trim() || name.trim() === m.name) return;
  s.history.transact(`Rename marker ‘${m.name}’`, (d) => renameMarker(d, id, name));
}

export function moveMarkerTo(s: Services, id: MarkerId, tick: Tick): void {
  const m = s.doc.getState().project.playlist.markers[id];
  if (!m || Math.round(tick) === m.tick) return;
  s.history.transact(`Move marker ‘${m.name}’`, (d) => moveMarker(d, id, tick));
}

export function deleteMarker(s: Services, id: MarkerId): void {
  const m = s.doc.getState().project.playlist.markers[id];
  if (m) s.history.transact(`Delete marker ‘${m.name}’`, (d) => removeMarker(d, id));
}

/** Sets the song position (song mode); playback continues from there when playing. */
export function jumpTo(s: Services, tick: Tick): void {
  const v = s.view.getState();
  v.setSongStart(tick);
  if (v.mode !== 'song') v.setMode('song');
  if (s.engine.playing) s.engine.play(tick);
}

export function jumpToMarker(s: Services, id: MarkerId): void {
  const m = s.doc.getState().project.playlist.markers[id];
  if (m) jumpTo(s, m.tick);
}

/** The marker after (`dir` 1) or before (−1) the song position. */
export function adjacentMarker(s: Services, dir: 1 | -1, from: Tick = songPosition(s)): Marker | null {
  const sorted = markersSorted(s.doc.getState().project);
  if (dir > 0) return sorted.find((m) => m.tick > from) ?? null;
  // Just after a marker counts as on it (playback has moved on): go to the one before.
  const grace = s.engine.playing ? 960 : 0;
  return [...sorted].reverse().find((m) => m.tick < from - grace) ?? null;
}

/** Loop region from a marker to the next one (or to the song's end). */
export function loopToNextMarker(s: Services, id: MarkerId): boolean {
  const p = s.doc.getState().project;
  const m = p.playlist.markers[id];
  if (!m) return false;
  const next = markersSorted(p).find((x) => x.tick > m.tick);
  const end = next?.tick ?? Math.max(songLength(p), m.tick + ticksPerBar(p.transport.timeSig));
  if (end <= m.tick) return false;
  const v = s.view.getState();
  v.setLoop({ start: m.tick, end });
  if (v.mode !== 'song') v.setMode('song');
  return true;
}

/** "Drop at 17:01:000" */
export function describeMarker(s: Services, m: Marker): string {
  return `${m.name} at ${formatBST(m.tick, s.doc.getState().project.transport.timeSig)}`;
}
