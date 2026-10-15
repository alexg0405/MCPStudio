import type { Draft } from 'immer';
import { playbackMode, sourceSecondsAt } from '../audio/playback';
import { newId } from '../model/ids';
import type { TempoMap } from '../time/ppq';
import type {
  ChannelId,
  Clip,
  ClipId,
  Lane,
  LaneId,
  Note,
  NoteId,
  Pattern,
  PatternId,
  Project,
  Tick,
} from '../model/types';

// Draft mutators for patterns, playlist lanes and clips.

// ---- Patterns ----

export function addPattern(d: Draft<Project>, pattern: Pattern, index?: number): void {
  d.patterns[pattern.id] = pattern as Draft<Pattern>;
  const at = index === undefined ? d.patternOrder.length : Math.max(0, Math.min(index, d.patternOrder.length));
  d.patternOrder.splice(at, 0, pattern.id);
}

/** Copies a pattern (all channels' notes, with fresh note ids) right after the original. */
export function clonePattern(d: Draft<Project>, sourceId: PatternId, copyId: PatternId, name: string): void {
  const src = d.patterns[sourceId];
  if (!src) return;
  const notes: Record<ChannelId, Record<NoteId, Note>> = {};
  for (const [cid, byId] of Object.entries(src.notes)) {
    if (!byId) continue;
    const copy: Record<NoteId, Note> = {};
    for (const n of Object.values(byId)) {
      const id = newId.note();
      copy[id] = { ...n, id };
    }
    notes[cid as ChannelId] = copy;
  }
  const clone: Pattern = { id: copyId, name, color: src.color, stepCount: src.stepCount, notes };
  if (src.length !== undefined) clone.length = src.length;
  addPattern(d, clone, d.patternOrder.indexOf(sourceId) + 1);
}

/** Deletes a pattern and its playlist clips; the project always keeps at least one pattern. */
export function removePattern(d: Draft<Project>, id: PatternId): void {
  if (!d.patterns[id] || d.patternOrder.length <= 1) return;
  delete d.patterns[id];
  d.patternOrder.splice(d.patternOrder.indexOf(id), 1);
  for (const [cid, clip] of Object.entries(d.playlist.clips)) {
    if (clip.kind === 'pattern' && clip.patternId === id) delete d.playlist.clips[cid as ClipId];
  }
}

export function setPatternProps(d: Draft<Project>, id: PatternId, patch: { name?: string; color?: string }): void {
  const p = d.patterns[id];
  if (!p) return;
  if (patch.name !== undefined && patch.name.trim()) p.name = patch.name.trim().slice(0, 64);
  if (patch.color !== undefined) p.color = patch.color;
}

export function movePattern(d: Draft<Project>, id: PatternId, toIndex: number): void {
  const from = d.patternOrder.indexOf(id);
  if (from < 0) return;
  d.patternOrder.splice(from, 1);
  d.patternOrder.splice(Math.max(0, Math.min(toIndex, d.patternOrder.length)), 0, id);
}

// ---- Lanes ----

export function addLane(d: Draft<Project>, lane: Lane, index?: number): void {
  d.playlist.lanes[lane.id] = lane as Draft<Lane>;
  const at = index === undefined ? d.playlist.laneOrder.length : index;
  d.playlist.laneOrder.splice(at, 0, lane.id);
}

export function setLaneProps(
  d: Draft<Project>,
  id: LaneId,
  patch: Partial<Pick<Lane, 'name' | 'color' | 'muted' | 'solo'>>,
): void {
  const lane = d.playlist.lanes[id];
  if (!lane) return;
  if (patch.name !== undefined && patch.name.trim()) lane.name = patch.name.trim().slice(0, 64);
  if (patch.color !== undefined) lane.color = patch.color;
  if (patch.muted !== undefined) lane.muted = patch.muted;
  if (patch.solo !== undefined) lane.solo = patch.solo;
}

/** Deletes a lane and its clips; the playlist always keeps at least one lane. */
export function removeLane(d: Draft<Project>, id: LaneId): void {
  if (!d.playlist.lanes[id] || d.playlist.laneOrder.length <= 1) return;
  delete d.playlist.lanes[id];
  d.playlist.laneOrder.splice(d.playlist.laneOrder.indexOf(id), 1);
  for (const [cid, clip] of Object.entries(d.playlist.clips)) {
    if (clip.laneId === id) delete d.playlist.clips[cid as ClipId];
  }
}

/** FL-style exclusive lane solo (soloing the only soloed lane clears it). */
export function toggleSoloLane(d: Draft<Project>, id: LaneId): void {
  const lane = d.playlist.lanes[id];
  if (!lane) return;
  const only = !!lane.solo && d.playlist.laneOrder.every((lid) => lid === id || !d.playlist.lanes[lid]?.solo);
  for (const lid of d.playlist.laneOrder) {
    const l = d.playlist.lanes[lid];
    if (l) l.solo = only ? false : lid === id;
  }
  if (!only) lane.muted = false;
}

// ---- Clips ----

export function addClips(d: Draft<Project>, clips: readonly Clip[]): void {
  for (const c of clips) d.playlist.clips[c.id] = sanitizeClip(c) as Draft<Clip>;
}

export function removeClips(d: Draft<Project>, ids: readonly ClipId[]): void {
  for (const id of ids) delete d.playlist.clips[id];
}

export interface ClipEdit {
  id: ClipId;
  start?: Tick;
  length?: Tick;
  laneId?: LaneId;
  /** Pattern clips: content offset in ticks. */
  offset?: Tick;
  /** Audio clips: trim into the sample in seconds. */
  offsetSec?: number;
  muted?: boolean;
}

export function editClips(d: Draft<Project>, edits: readonly ClipEdit[]): void {
  for (const e of edits) {
    const c = d.playlist.clips[e.id];
    if (!c) continue;
    if (e.start !== undefined) c.start = Math.max(0, Math.round(e.start));
    if (e.length !== undefined) c.length = Math.max(1, Math.round(e.length));
    if (e.laneId !== undefined && d.playlist.lanes[e.laneId]) c.laneId = e.laneId;
    if (e.muted !== undefined) c.muted = e.muted;
    if (e.offset !== undefined && c.kind !== 'audio') c.offset = Math.max(0, Math.round(e.offset));
    if (e.offsetSec !== undefined && c.kind === 'audio') c.offsetSec = Math.max(0, e.offsetSec);
  }
}

/**
 * Splits a clip at `at` (song ticks) into two; the right half continues where the left ended.
 * Audio clips: the split point becomes the right half's trim into the sample, through the tempo map
 * and the channel's pitch, reverse and tempo follow (core/audio/playback.ts).
 */
export function splitClip(
  d: Draft<Project>,
  id: ClipId,
  at: Tick,
  tempo: TempoMap,
  rightId: ClipId = newId.clip(),
): void {
  const c = d.playlist.clips[id];
  if (!c || at <= c.start || at >= c.start + c.length) return;
  const leftLen = at - c.start;
  const right = { ...c, id: rightId, start: at, length: c.length - leftLen } as Clip;
  if (right.kind === 'pattern' || right.kind === 'automation')
    right.offset = (c.kind === 'audio' ? 0 : c.offset) + leftLen;
  if (right.kind === 'audio' && c.kind === 'audio') {
    const ch = d.channels[c.channelId];
    right.offsetSec = sourceSecondsAt(c, playbackMode(ch?.kind === 'audioClip' ? ch : {}), tempo, at);
  }
  c.length = leftLen;
  d.playlist.clips[rightId] = right as Draft<Clip>;
}

/**
 * FL's "Make unique": the clip gets its own copy of its pattern (fresh note ids), so editing it no
 * longer changes the other clips of that pattern.
 */
export function makeClipUnique(d: Draft<Project>, clipId: ClipId, copyId: PatternId, name: string): void {
  const clip = d.playlist.clips[clipId];
  if (!clip || clip.kind !== 'pattern' || !d.patterns[clip.patternId]) return;
  clonePattern(d, clip.patternId, copyId, name);
  clip.patternId = copyId;
}

export function sanitizeClip<C extends Clip>(c: C): C {
  return { ...c, start: Math.max(0, Math.round(c.start)), length: Math.max(1, Math.round(c.length)) };
}

/**
 * Removes the clips over from–to (on `lanes`, or on every track). With `trim`, a clip that reaches
 * past an edge is cut there and keeps its part outside the range; without it, every clip touching
 * the range goes. `only` limits it to some clips (the others stay as they are).
 */
export function clearRange(
  d: Draft<Project>,
  from: Tick,
  to: Tick,
  opts: { lanes?: ReadonlySet<LaneId>; trim?: boolean; tempo: TempoMap; only?: (clip: Clip) => boolean },
): { removed: number; cut: number } {
  let removed = 0;
  let cut = 0;
  for (const c of Object.values(d.playlist.clips)) {
    if (opts.lanes && !opts.lanes.has(c.laneId)) continue;
    if (opts.only && !opts.only(c as Clip)) continue;
    const end = c.start + c.length;
    if (c.start >= to || end <= from) continue;
    if (!opts.trim || (c.start >= from && end <= to)) {
      delete d.playlist.clips[c.id];
      removed++;
      continue;
    }
    let middle = c.id;
    if (c.start < from) {
      const right = newId.clip();
      splitClip(d, c.id, from, opts.tempo, right);
      middle = right;
      cut++;
    }
    const m = d.playlist.clips[middle]!;
    if (m.start + m.length > to) {
      splitClip(d, middle, to, opts.tempo, newId.clip());
      cut++;
    }
    delete d.playlist.clips[middle];
    removed++;
  }
  return { removed, cut };
}
