import type { Draft } from 'immer';
import { newId } from '../model/ids';
import type { Marker, MarkerId, Project, Tick } from '../model/types';

// Draft mutators for playlist markers (named song positions: "Verse", "Drop").

const MAX_NAME = 64;

const cleanName = (name: string) => name.trim().slice(0, MAX_NAME) || 'Marker';

/** Adds a marker at a song tick; returns its id. */
export function addMarker(
  d: Draft<Project>,
  tick: Tick,
  name: string,
  opts: { id?: MarkerId; color?: string } = {},
): MarkerId {
  const id = opts.id ?? newId.marker();
  const marker: Marker = { id, tick: Math.max(0, Math.round(tick)), name: cleanName(name) };
  if (opts.color) marker.color = opts.color;
  d.playlist.markers[id] = marker;
  return id;
}

export function moveMarker(d: Draft<Project>, id: MarkerId, tick: Tick): void {
  const m = d.playlist.markers[id];
  if (m) m.tick = Math.max(0, Math.round(tick));
}

export function renameMarker(d: Draft<Project>, id: MarkerId, name: string): void {
  const m = d.playlist.markers[id];
  if (m) m.name = cleanName(name);
}

export function removeMarker(d: Draft<Project>, id: MarkerId): void {
  delete d.playlist.markers[id];
}

/** Markers by song position. */
export function markersSorted(p: Project): Marker[] {
  return Object.values(p.playlist.markers).sort((a, b) => a.tick - b.tick || a.name.localeCompare(b.name));
}
