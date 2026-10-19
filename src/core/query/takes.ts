/**
 * Take groups: the takes of one recording, the comp lane that plays them and the take lanes folded under
 * it. Derived from the playlist (`AudioClip.take`, `Lane.takes`), so there is nothing else to keep in step.
 */
import { produce } from 'immer';
import { DEFAULT_CROSSFADE_MS, type CompSpan } from '../audio/comp';
import { playbackMode, sourceSecondsAt } from '../audio/playback';
import type { AudioClip, Clip, ClipId, LaneId, Playlist, Project, Tick } from '../model/types';
import type { TempoMap } from '../time/ppq';

/**
 * The takes of one recording and where they live: the comp lane and its clips, the take lanes and each take's clips,
 * the crossfade and the extent in song ticks.
 */
export interface TakeGroup {
  id: string;
  /** The track that plays the comp (null if it was deleted: the group is then repaired away). */
  compLane: LaneId | null;
  /** The take lanes, in playlist order (newest take first). */
  takeLanes: LaneId[];
  /** Take clips by take, in recording order. */
  takes: Array<{ index: number; clips: AudioClip[] }>;
  /** The comp lane's clips, in time order. */
  comp: AudioClip[];
  crossfadeMs: number;
  /** The extent of the takes. */
  start: Tick;
  end: Tick;
}

type Lanes = Pick<Playlist, 'lanes' | 'laneOrder' | 'clips'>;

/** Builds the groups of a playlist (not memoized: safe on immer drafts). */
export function buildTakeGroups(pl: Lanes): TakeGroup[] {
  const groups = new Map<string, TakeGroup>();
  const get = (id: string): TakeGroup => {
    let g = groups.get(id);
    if (!g) {
      g = { id, compLane: null, takeLanes: [], takes: [], comp: [], crossfadeMs: DEFAULT_CROSSFADE_MS, start: Infinity, end: -Infinity };
      groups.set(id, g);
    }
    return g;
  };
  for (const laneId of pl.laneOrder) {
    const t = pl.lanes[laneId]?.takes;
    if (!t) continue;
    const g = get(t.group);
    if (t.role === 'comp') {
      g.compLane = laneId;
      if (t.crossfadeMs !== undefined) g.crossfadeMs = t.crossfadeMs;
    } else g.takeLanes.push(laneId);
  }
  const byTake = new Map<string, Map<number, AudioClip[]>>();
  for (const c of Object.values(pl.clips) as Clip[]) {
    if (c.kind !== 'audio' || !c.take) continue;
    const g = get(c.take.group);
    if (c.take.comp) g.comp.push(c);
    else {
      let m = byTake.get(g.id);
      if (!m) byTake.set(g.id, (m = new Map()));
      const list = m.get(c.take.index);
      if (list) list.push(c);
      else m.set(c.take.index, [c]);
      g.start = Math.min(g.start, c.start);
      g.end = Math.max(g.end, c.start + c.length);
    }
  }
  for (const g of groups.values()) {
    const m = byTake.get(g.id);
    g.takes = m
      ? [...m.entries()].sort((a, b) => a[0] - b[0]).map(([index, clips]) => ({ index, clips: clips.sort((a, b) => a.start - b.start) }))
      : [];
    g.comp.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
    if (!Number.isFinite(g.start)) {
      g.start = 0;
      g.end = 0;
    }
  }
  return [...groups.values()];
}

const cache = new WeakMap<object, WeakMap<object, readonly TakeGroup[]>>();
const NONE: readonly TakeGroup[] = [];

/** The take groups of a project, memoized by the playlist's lanes and clips. */
export function takeGroups(project: Project): readonly TakeGroup[] {
  const { clips, lanes } = project.playlist;
  let inner = cache.get(clips);
  if (!inner) cache.set(clips, (inner = new WeakMap()));
  let v = inner.get(lanes);
  if (!v) {
    // Most projects have none: skip the walk's allocations then.
    const any = Object.values(lanes).some((l) => l.takes) || Object.values(clips).some((c) => c.kind === 'audio' && c.take);
    v = any ? buildTakeGroups(project.playlist) : NONE;
    inner.set(lanes, v);
  }
  return v;
}

/** The take group with this id, or null when there is none. */
export function takeGroup(project: Project, id: string): TakeGroup | null {
  return takeGroups(project).find((g) => g.id === id) ?? null;
}

/**
 * The other recordings' take groups whose time range overlaps this one's (they have a comp lane and takes): the ones
 * "Add these takes to the comp" can merge with, the most overlapping first.
 */
export function overlappingGroups(project: Project, group: TakeGroup): TakeGroup[] {
  const overlapOf = (other: TakeGroup) => Math.min(group.end, other.end) - Math.max(group.start, other.start);
  return takeGroups(project)
    .filter((other) => other.id !== group.id && other.compLane !== null && other.takes.length > 0 && overlapOf(other) > 0)
    .sort((a, b) => overlapOf(b) - overlapOf(a));
}

/** A recording's name as its tracks show it: the comp track's name without " · comp" (the group's id when it has none). */
export function groupName(project: Project, group: TakeGroup): string {
  const lane = group.compLane ? project.playlist.lanes[group.compLane] : undefined;
  return lane ? lane.name.replace(/ · comp$/, '') : group.id;
}

/** The group a lane belongs to (as its comp lane or one of its take lanes). */
export function groupOfLane(project: Project, laneId: LaneId): TakeGroup | null {
  const t = project.playlist.lanes[laneId]?.takes;
  return t ? takeGroup(project, t.group) : null;
}

/** The group a clip belongs to (a take or a comp clip), or one on a lane of a group. */
export function groupOfClip(project: Project, clip: Clip): TakeGroup | null {
  if (clip.kind === 'audio' && clip.take) return takeGroup(project, clip.take.group);
  return groupOfLane(project, clip.laneId);
}

const orderCache = new WeakMap<object, WeakMap<object, Map<string, readonly LaneId[]>>>();

/**
 * The tracks that are on screen, in order: every track except the take lanes of groups that are folded
 * (a group is open when its id is in `open`). Memoized by the lanes and the open set's contents.
 */
export function visibleLaneOrder(project: Project, open: readonly string[]): readonly LaneId[] {
  const { laneOrder, lanes } = project.playlist;
  const key = open.length ? [...open].sort().join('|') : '';
  let byLanes = orderCache.get(laneOrder);
  if (!byLanes) orderCache.set(laneOrder, (byLanes = new WeakMap()));
  let byKey = byLanes.get(lanes);
  if (!byKey) byLanes.set(lanes, (byKey = new Map()));
  let v = byKey.get(key);
  if (!v) {
    const isOpen = new Set(open);
    v = laneOrder.filter((id) => {
      const t = lanes[id]?.takes;
      return !t || t.role === 'comp' || isOpen.has(t.group);
    });
    if (byKey.size > 8) byKey.clear();
    byKey.set(key, v);
  }
  return v;
}

/** The spans of a group's takes for the comp planner. */
export function compSpans(project: Project, group: TakeGroup, tempo: TempoMap): CompSpan[] {
  const out: CompSpan[] = [];
  for (const t of group.takes)
    for (const c of t.clips) {
      const ch = project.channels[c.channelId];
      const mode = playbackMode(ch?.kind === 'audioClip' ? ch : {});
      out.push({
        index: t.index,
        ref: c.id,
        start: c.start,
        length: c.length,
        offsetAt: (tick) => sourceSecondsAt(c, mode, tempo, tick),
        ...(c.gain !== undefined ? { gain: c.gain } : {}),
        ...(c.fadeIn !== undefined ? { fadeIn: c.fadeIn } : {}),
        ...(c.fadeOut !== undefined ? { fadeOut: c.fadeOut } : {}),
      });
    }
  return out;
}

/** The take clip a take track's speaker button listens to: its first clip (null on any other track). */
export function takeClipOnLane(project: Project, laneId: LaneId): ClipId | null {
  if (project.playlist.lanes[laneId]?.takes?.role !== 'take') return null;
  let best: AudioClip | null = null;
  for (const c of Object.values(project.playlist.clips) as Clip[])
    if (c.kind === 'audio' && c.laneId === laneId && c.take && !c.take.comp && (!best || c.start < best.start)) best = c;
  return best?.id ?? null;
}

const auditionCache = new WeakMap<object, Map<string, Project>>();

/** True when the clip is a take clip (a recording's own take, not the comp) that can be listened to alone. */
export function isTakeClip(project: Project, id: ClipId | null | undefined): boolean {
  const c = id ? project.playlist.clips[id] : undefined;
  return c?.kind === 'audio' && !!c.take && !c.take.comp;
}

/**
 * The project as the engine plays it while one take is auditioned ("listen to this take"): every clip of the take's
 * group (the comp and the other takes) is silent except that take, whose track is made audible even when it is
 * muted or another track is soloed. The document is not touched: this is a copy for the engine (memoized by
 * project and clip), and the same project comes back when the clip is not a take clip.
 */
export function auditionProject(project: Project, clipId: ClipId | null): Project {
  if (!clipId || !isTakeClip(project, clipId)) return project;
  let byClip = auditionCache.get(project);
  if (!byClip) auditionCache.set(project, (byClip = new Map()));
  let v = byClip.get(clipId);
  if (!v) {
    const group = (project.playlist.clips[clipId] as AudioClip).take!.group;
    v = produce(project, (d) => {
      const anySolo = Object.values(d.playlist.lanes).some((l) => l.solo);
      for (const c of Object.values(d.playlist.clips)) {
        if (c.kind !== 'audio' || c.take?.group !== group) continue;
        c.muted = c.id !== clipId;
        if (c.id === clipId) {
          const lane = d.playlist.lanes[c.laneId];
          if (lane) {
            lane.muted = false;
            if (anySolo) lane.solo = true;
          }
        }
      }
    });
    byClip.set(clipId, v);
  }
  return v;
}

/** The take clips of a group by clip id. */
export function takeClipIds(group: TakeGroup): ClipId[] {
  return group.takes.flatMap((t) => t.clips.map((c) => c.id));
}
