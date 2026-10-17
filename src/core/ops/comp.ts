/**
 * Draft mutators for comps (one call = one `history.transact`). The comp lane is rebuilt from a list of
 * segments each time (`core/audio/comp.ts`): its old clips go, plain audio clips split at the segments'
 * borders come, so undo restores the lane exactly as it was.
 */
import type { Draft } from 'immer';
import {
  planComp,
  readComp,
  stepTake,
  swipeSegments,
  wholeTake,
  type CompSegment,
  DEFAULT_CROSSFADE_MS,
  MAX_CROSSFADE_MS,
} from '../audio/comp';
import { newId, randomId } from '../model/ids';
import { makeLane } from '../model/defaults';
import type { AudioClip, ChannelId, ClipId, LaneId, Project, Tick } from '../model/types';
import { buildTakeGroups, compSpans, type TakeGroup } from '../query/takes';
import type { TempoMap } from '../time/ppq';

/** A fresh take group id. */
export const newTakeGroup = (): string => randomId('take');

function groupIn(d: Draft<Project>, id: string): TakeGroup | null {
  return buildTakeGroups(d.playlist).find((g) => g.id === id) ?? null;
}

/** The comp's segments as they are now (what the comp lane's clips play, without the crossfades). */
export function compSegmentsOf(group: TakeGroup): CompSegment[] {
  return readComp(group.comp.map((c) => ({ start: c.start, length: c.length, take: c.take?.index ?? 0 })));
}

/**
 * Replaces the comp lane's clips with the plan for `segments`. Returns the new clips' ids (empty when the
 * group has no comp lane).
 */
export function setComp(d: Draft<Project>, groupId: string, segments: readonly CompSegment[], tempo: TempoMap): ClipId[] {
  const g = groupIn(d, groupId);
  if (!g?.compLane) return [];
  const project = d as unknown as Project;
  const spans = compSpans(project, g, tempo);
  const plan = planComp(segments, spans, { tempo, crossfadeSec: g.crossfadeMs / 1000 });
  const byRef = new Map(g.takes.flatMap((t) => t.clips).map((c) => [c.id as string, c]));
  for (const c of g.comp) delete d.playlist.clips[c.id];
  const ids: ClipId[] = [];
  for (const p of plan) {
    const take = byRef.get(p.ref);
    if (!take) continue;
    const id = newId.clip();
    const clip: AudioClip = {
      kind: 'audio',
      id,
      laneId: g.compLane,
      start: p.start,
      length: Math.max(1, p.length),
      channelId: take.channelId,
      offsetSec: p.offsetSec,
      take: { group: groupId, index: p.take, comp: true },
      ...(take.name !== undefined ? { name: take.name } : {}),
      ...(take.color !== undefined ? { color: take.color } : {}),
      ...(p.gain !== undefined ? { gain: p.gain } : {}),
      ...(p.fadeIn !== undefined ? { fadeIn: p.fadeIn } : {}),
      ...(p.fadeOut !== undefined ? { fadeOut: p.fadeOut } : {}),
    };
    d.playlist.clips[id] = clip as Draft<AudioClip>;
    ids.push(id);
  }
  return ids;
}

/** Swipe: take `take` plays over [from, to]. Returns the new comp clips (empty when nothing changed). */
export function compSwipe(
  d: Draft<Project>,
  groupId: string,
  take: number,
  from: Tick,
  to: Tick,
  tempo: TempoMap,
): ClipId[] {
  const g = groupIn(d, groupId);
  if (!g?.compLane) return [];
  const spans = compSpans(d as unknown as Project, g, tempo);
  return setComp(d, groupId, swipeSegments(compSegmentsOf(g), spans, take, from, to), tempo);
}

/** "Use this take": the whole take plays, in place of the whole comp. */
export function compUseTake(d: Draft<Project>, groupId: string, take: number, tempo: TempoMap): ClipId[] {
  const g = groupIn(d, groupId);
  if (!g?.compLane) return [];
  const spans = compSpans(d as unknown as Project, g, tempo);
  return setComp(d, groupId, wholeTake(spans, take), tempo);
}

/**
 * "Next take" / "Previous take" for [from, to]: the neighbouring take plays there. Returns the take now
 * playing the range (null when no other take has audio there).
 */
export function compStep(
  d: Draft<Project>,
  groupId: string,
  from: Tick,
  to: Tick,
  dir: 1 | -1,
  tempo: TempoMap,
): number | null {
  const g = groupIn(d, groupId);
  if (!g?.compLane) return null;
  const spans = compSpans(d as unknown as Project, g, tempo);
  const segments = compSegmentsOf(g);
  const next = stepTake(segments, spans, from, to, dir);
  if (next === null) return null;
  setComp(d, groupId, swipeSegments(segments, spans, next, from, to), tempo);
  return next;
}

/** Sets the crossfade at the comp's borders and rebuilds the comp with it. */
export function compSetCrossfade(d: Draft<Project>, groupId: string, ms: number, tempo: TempoMap): void {
  const g = groupIn(d, groupId);
  if (!g?.compLane) return;
  const value = Math.round(Math.max(0, Math.min(MAX_CROSSFADE_MS, Number.isFinite(ms) ? ms : DEFAULT_CROSSFADE_MS)) * 10) / 10;
  const lane = d.playlist.lanes[g.compLane];
  if (!lane?.takes) return;
  lane.takes.crossfadeMs = value;
  setComp(d, groupId, compSegmentsOf(g), tempo);
}

/**
 * Flatten: the comp becomes ordinary clips on its track and the take lanes (with the takes) go. What plays
 * stays exactly as it is (the takes were muted).
 */
export function flattenComp(d: Draft<Project>, groupId: string): { removedLanes: number } {
  const g = groupIn(d, groupId);
  if (!g) return { removedLanes: 0 };
  for (const t of g.takes) for (const c of t.clips) delete d.playlist.clips[c.id];
  for (const c of g.comp) {
    const clip = d.playlist.clips[c.id];
    if (clip?.kind === 'audio') delete clip.take;
  }
  let removedLanes = 0;
  for (const id of g.takeLanes) {
    if (dropLane(d, id)) removedLanes++;
    else delete d.playlist.lanes[id]?.takes;
  }
  const comp = g.compLane ? d.playlist.lanes[g.compLane] : undefined;
  if (comp) delete comp.takes;
  return { removedLanes };
}

/** Deletes a lane that holds no clips any more (the playlist keeps at least one). */
function dropLane(d: Draft<Project>, id: LaneId): boolean {
  if (!d.playlist.lanes[id] || d.playlist.laneOrder.length <= 1) return false;
  for (const c of Object.values(d.playlist.clips)) if (c.laneId === id) return false;
  delete d.playlist.lanes[id];
  d.playlist.laneOrder.splice(d.playlist.laneOrder.indexOf(id), 1);
  return true;
}

export interface NewTake {
  start: Tick;
  length: Tick;
  offsetSec: number;
  name?: string;
}

/**
 * Adds the takes of a recording as a take group: the comp lane on track `first` (0-based), the take lanes
 * under it (the last take, the newest, nearest the top), the take clips (muted: the comp plays) and the comp,
 * which starts as the take `audible`. The tracks are `first … first + takes.length`; tracks past the end of the
 * playlist are added, and existing (free) ones are renamed when they still have their default name.
 */
export function addTakeGroup(
  d: Draft<Project>,
  o: {
    group: string;
    name: string;
    channelId: ChannelId;
    takes: readonly NewTake[];
    audible: number;
    first: number;
    tempo: TempoMap;
    /** The comp's crossfade (default 10 ms). */
    crossfadeMs?: number;
  },
): { takes: ClipId[]; comp: ClipId[] } {
  const n = o.takes.length;
  const laneAt = (i: number, role: 'comp' | 'take', label: string): LaneId => {
    let id = d.playlist.laneOrder[i];
    if (!id) {
      const lane = makeLane(label);
      d.playlist.lanes[lane.id] = lane as Draft<ReturnType<typeof makeLane>>;
      d.playlist.laneOrder.push(lane.id);
      id = lane.id;
    }
    const lane = d.playlist.lanes[id]!;
    if (/^Track \d+$/.test(lane.name)) lane.name = label;
    lane.takes = { group: o.group, role };
    return id;
  };
  const compId = laneAt(o.first, 'comp', `${o.name} · comp`);
  const compTakes = d.playlist.lanes[compId]?.takes;
  if (compTakes && o.crossfadeMs !== undefined && o.crossfadeMs !== DEFAULT_CROSSFADE_MS) compTakes.crossfadeMs = o.crossfadeMs;
  const ids: ClipId[] = [];
  for (let i = 0; i < n; i++) {
    // Newest take first, under the comp lane.
    const lane = laneAt(o.first + 1 + (n - 1 - i), 'take', `${o.name} · take ${i + 1}`);
    const t = o.takes[i] as NewTake;
    const id = newId.clip();
    d.playlist.clips[id] = {
      kind: 'audio',
      id,
      laneId: lane,
      start: t.start,
      length: t.length,
      channelId: o.channelId,
      offsetSec: t.offsetSec,
      name: t.name ?? `${o.name} · take ${i + 1}`,
      muted: true,
      take: { group: o.group, index: i },
    } as Draft<AudioClip>;
    ids.push(id);
  }
  const spans = compSpans(d as unknown as Project, groupIn(d, o.group)!, o.tempo);
  const comp = setComp(d, o.group, wholeTake(spans, o.audible), o.tempo);
  return { takes: ids, comp };
}
