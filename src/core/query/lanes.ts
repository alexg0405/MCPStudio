/** Finding room on the playlist for new clips (recorded takes, frozen and consolidated audio). */
import type { Project, Tick } from '../model/types';

/** True when no clip on lane index `i` overlaps [start, end). Lanes past the last one are free. */
export function laneFree(project: Project, i: number, start: Tick, end: Tick): boolean {
  const id = project.playlist.laneOrder[i];
  if (!id) return true;
  // The comp and take lanes of a recording hold only that recording.
  if (project.playlist.lanes[id]?.takes) return false;
  for (const c of Object.values(project.playlist.clips))
    if (c.laneId === id && c.start < end && c.start + c.length > start) return false;
  return true;
}

/**
 * The first index from `from` on where `count` lanes in a row are free over [start, end). It may
 * run past the last lane: lanes from `project.playlist.laneOrder.length` on have to be added.
 */
export function freeLaneRun(project: Project, start: Tick, end: Tick, count = 1, from = 0): number {
  for (let i = Math.max(0, from); ; i++) {
    let ok = true;
    for (let k = 0; k < count; k++)
      if (!laneFree(project, i + k, start, end)) {
        ok = false;
        break;
      }
    if (ok) return i;
  }
}
