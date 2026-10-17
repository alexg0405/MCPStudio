/** Derived playlist data shared by the engine and the UI. */
import type { Clip, ClipId, LaneId, PatternId, Playlist, Project, Tick } from '../model/types';
import { ceilToBars, ticksPerBar } from '../time/ppq';
import { patternLength } from './queries';

const sortedCache = new WeakMap<object, readonly Clip[]>();

/** Clips sorted by start (memoized by the clips record's identity). */
export function clipsSorted(clips: Playlist['clips']): readonly Clip[] {
  let v = sortedCache.get(clips);
  if (!v) {
    v = Object.values(clips).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
    sortedCache.set(clips, v);
  }
  return v;
}

const lengthCache = new WeakMap<object, { num: number; den: number; value: Tick }>();

/**
 * End of the last clip, rounded up to whole bars (0 when the playlist is empty). Memoized by the clips
 * record's identity and the time signature: the view asks for it every frame while a song plays, and
 * walking every clip each time built a list of them each frame.
 */
export function songLength(project: Project): Tick {
  const clips = project.playlist.clips;
  const ts = project.transport.timeSig;
  const hit = lengthCache.get(clips);
  if (hit && hit.num === ts.num && hit.den === ts.den) return hit.value;
  let end = 0;
  for (const c of Object.values(clips)) end = Math.max(end, c.start + c.length);
  const value = end === 0 ? 0 : ceilToBars(end, ts);
  lengthCache.set(clips, { num: ts.num, den: ts.den, value });
  return value;
}

/** Lanes that don't play: muted, or not soloed while another lane is. */
export function mutedLanes(playlist: Playlist): ReadonlySet<LaneId> {
  const lanes = Object.values(playlist.lanes);
  const anySolo = lanes.some((l) => l.solo);
  return new Set(lanes.filter((l) => l.muted || (anySolo && !l.solo)).map((l) => l.id));
}

/** Clips that play in song mode (not muted themselves, lane audible, referenced pattern/channel exists). */
export function audibleClips(project: Project): Clip[] {
  const muted = mutedLanes(project.playlist);
  return clipsSorted(project.playlist.clips).filter((c) => {
    if (c.muted || muted.has(c.laneId)) return false;
    if (c.kind === 'pattern') return !!project.patterns[c.patternId];
    return !!project.channels[c.channelId];
  });
}

/** Default length for a new clip of a pattern: the pattern's own length. */
export function patternClipLength(project: Project, patternId: PatternId): Tick {
  const p = project.patterns[patternId];
  return p ? patternLength(p, project.transport.timeSig) : ticksPerBar(project.transport.timeSig);
}

/**
 * Where a song position falls inside a pattern (for the piano roll playhead in song mode):
 * the pattern tick of the first clip of `patternId` playing at `songTick`, or null.
 */
export function patternTickAt(project: Project, songTick: number, patternId: PatternId): number | null {
  const pattern = project.patterns[patternId];
  if (!pattern) return null;
  const len = patternLength(pattern, project.transport.timeSig);
  for (const c of clipsSorted(project.playlist.clips)) {
    if (c.start > songTick) break;
    if (c.kind === 'pattern' && c.patternId === patternId && songTick < c.start + c.length) {
      return (songTick - c.start + c.offset) % len;
    }
  }
  return null;
}

/** Clips intersecting [t0, t1). */
export function clipsInRange(clips: readonly Clip[], t0: Tick, t1: Tick): Clip[] {
  return clips.filter((c) => c.start < t1 && c.start + c.length > t0);
}

/** Topmost clip under (tick, lane). */
export function clipAt(clips: readonly Clip[], tick: number, laneId: LaneId): Clip | undefined {
  let hit: Clip | undefined;
  for (const c of clips) {
    if (c.start > tick) break;
    if (c.laneId === laneId && tick < c.start + c.length) hit = c;
  }
  return hit;
}

/** Clips intersecting a tick range on a set of lanes. */
export function clipsInRect(clips: readonly Clip[], t0: Tick, t1: Tick, lanes: ReadonlySet<LaneId>): ClipId[] {
  return clips.filter((c) => lanes.has(c.laneId) && c.start < t1 && c.start + c.length > t0).map((c) => c.id);
}
