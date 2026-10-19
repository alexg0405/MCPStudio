import type { Draft } from 'immer';
import { makeLane } from '../../model/defaults';
import type { LaneId, Project } from '../../model/types';
import { LaneAllocator } from '../plan';

/** The name a new lane gets from the playlist: "Track 1", "Track 2"… (empty ones are reused). */
const DEFAULT_LANE = /^Track \d+$/;
/** Longest lane name the playlist accepts. */
const MAX_LANE_NAME = 64;

/**
 * A lane by name: the one with that name, else the first empty "Track N", else a new one. Never a
 * recording's comp or take lane: those hold only that recording.
 */
export function laneNamed(d: Draft<Project>, name: string): LaneId {
  for (const id of d.playlist.laneOrder) {
    if (d.playlist.lanes[id]?.name === name && !d.playlist.lanes[id]?.takes) return id;
  }
  const used = new Set(Object.values(d.playlist.clips).map((c) => c.laneId));
  for (const id of d.playlist.laneOrder) {
    const lane = d.playlist.lanes[id];
    if (lane && !lane.takes && !used.has(id) && DEFAULT_LANE.test(lane.name)) {
      lane.name = name.slice(0, MAX_LANE_NAME);
      return id;
    }
  }
  const lane = makeLane(name.slice(0, MAX_LANE_NAME));
  d.playlist.lanes[lane.id] = lane;
  d.playlist.laneOrder.push(lane.id);
  return lane.id;
}

/** Free lanes of a group for new FX, crashes and automation next to what is already on the song. */
export function laneAllocatorFor(p: Project): LaneAllocator {
  const lanes = new LaneAllocator();
  const names = new Map(p.playlist.laneOrder.map((id) => [id, p.playlist.lanes[id]?.name ?? '']));
  for (const c of Object.values(p.playlist.clips)) lanes.occupy(names.get(c.laneId) ?? '', c.start, c.start + c.length);
  return lanes;
}
