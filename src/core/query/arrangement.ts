/**
 * The song's arrangement as a musician (or the AI) reads it: runs of repeated clips per track, where
 * each pattern plays, and problems such as the same part stacked on itself. Plain loops only: these
 * run on drafts inside edits too, where identity-memoized queries would go stale.
 */
import type { AutomationChannel, Clip, ClipId, LaneId, PatternClip, PatternId, Project, Tick } from '../model/types';
import { patternLength } from './queries';

export interface ClipRun {
  laneId: LaneId;
  kind: Clip['kind'];
  /** The pattern (pattern clips) or channel (audio and automation clips) it plays. */
  source: string;
  from: Tick;
  /** Exclusive end. */
  to: Tick;
  count: number;
  /** Length of each clip. */
  clipLength: Tick;
  clipIds: ClipId[];
  muted: boolean;
  /** Extra copies of these clips stacked on the same track (0 = none). */
  stacked: number;
}

const sourceOf = (c: Clip): string => (c.kind === 'pattern' ? c.patternId : c.channelId);
const offsetOf = (c: Clip): number => (c.kind === 'audio' ? c.offsetSec : c.offset);
const sameClip = (a: Clip, b: Clip) =>
  a.kind === b.kind &&
  sourceOf(a) === sourceOf(b) &&
  a.start === b.start &&
  a.length === b.length &&
  offsetOf(a) === offsetOf(b) &&
  !!a.muted === !!b.muted;

const byStart = (a: Clip, b: Clip) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Back-to-back clips of the same thing on one track, as runs ("Drop" ×8, bars 37–52). Runs also
 * break at `cuts` (section starts), so each run sits inside one section.
 */
export function laneRuns(p: Project, laneId: LaneId, cuts: readonly Tick[] = []): ClipRun[] {
  const clips = Object.values(p.playlist.clips)
    .filter((c) => c.laneId === laneId)
    .sort(byStart);
  // Exact copies stacked on the same track collapse into their first clip.
  const unique: { clip: Clip; copies: number }[] = [];
  for (const c of clips) {
    const twin = unique.find((u) => sameClip(u.clip, c));
    if (twin) twin.copies++;
    else unique.push({ clip: c, copies: 0 });
  }
  const cutSet = new Set(cuts);
  const runs: ClipRun[] = [];
  for (const { clip, copies } of unique) {
    const last = runs[runs.length - 1];
    const prevEnd = last ? last.to : -1;
    if (
      last &&
      last.kind === clip.kind &&
      last.source === sourceOf(clip) &&
      last.clipLength === clip.length &&
      last.muted === !!clip.muted &&
      clip.start === prevEnd &&
      last.stacked === copies &&
      !cutSet.has(clip.start)
    ) {
      last.to = clip.start + clip.length;
      last.count++;
      last.clipIds.push(clip.id);
      continue;
    }
    runs.push({
      laneId,
      kind: clip.kind,
      source: sourceOf(clip),
      from: clip.start,
      to: clip.start + clip.length,
      count: 1,
      clipLength: clip.length,
      clipIds: [clip.id],
      muted: !!clip.muted,
      stacked: copies,
    });
  }
  return runs;
}

/** Where each pattern plays (unmuted clips, any track), as merged spans. */
export function patternSpans(p: Project): Map<PatternId, { from: Tick; to: Tick }[]> {
  const raw = new Map<PatternId, { from: Tick; to: Tick }[]>();
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'pattern' || c.muted) continue;
    const list = raw.get(c.patternId) ?? [];
    list.push({ from: c.start, to: c.start + c.length });
    raw.set(c.patternId, list);
  }
  const out = new Map<PatternId, { from: Tick; to: Tick }[]>();
  for (const [pid, list] of raw) {
    list.sort((a, b) => a.from - b.from);
    const merged: { from: Tick; to: Tick }[] = [];
    for (const s of list) {
      const last = merged[merged.length - 1];
      if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
      else merged.push({ ...s });
    }
    out.set(pid, merged);
  }
  return out;
}

export interface StackedCopy {
  /** The extra clip. */
  clipId: ClipId;
  /** The clip it copies (the one to keep). */
  of: ClipId;
  from: Tick;
  to: Tick;
}

/**
 * Pattern clips that exactly repeat another clip at the same time (same pattern, start, length and
 * offset; any track): the part plays twice as loud. Of each group the clip on the topmost track is
 * kept; with `among`, only groups involving those clips count, and the clips in `among` are the ones
 * reported as copies (so a new clip on top of an older one is the one that goes).
 */
export function stackedCopies(p: Project, among?: ReadonlySet<ClipId>): StackedCopy[] {
  const lane = new Map(p.playlist.laneOrder.map((id, i) => [id, i]));
  const groups = new Map<string, Clip[]>();
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'pattern' || c.muted) continue;
    const key = `${c.patternId}|${c.start}|${c.length}|${c.offset}`;
    const g = groups.get(key) ?? [];
    g.push(c);
    groups.set(key, g);
  }
  const out: StackedCopy[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    if (among && !g.some((c) => among.has(c.id))) continue;
    // Keep: an older clip (not in `among`) first, then the topmost track.
    g.sort(
      (a, b) =>
        Number(among?.has(a.id) ?? false) - Number(among?.has(b.id) ?? false) ||
        (lane.get(a.laneId) ?? 0) - (lane.get(b.laneId) ?? 0) ||
        (a.id < b.id ? -1 : 1),
    );
    const keep = g[0]!;
    for (const c of g.slice(1)) out.push({ clipId: c.id, of: keep.id, from: c.start, to: c.start + c.length });
  }
  return out.sort((a, b) => a.from - b.from || (a.clipId < b.clipId ? -1 : 1));
}

export type SongIssue =
  /** The same clips play several times at once over from–to. */
  | { kind: 'stacked'; from: Tick; to: Tick; times: number; lanes: LaneId[] }
  /** A pattern overlaps itself (out of step, not an exact copy). */
  | { kind: 'doubled'; patternId: PatternId; from: Tick; to: Tick }
  /** The same clip back to back more than 4 times with no change. */
  | { kind: 'repeats'; laneId: LaneId; patternId: PatternId; from: Tick; to: Tick; count: number }
  /** Tracks with clips that still have their default "Track N" name. */
  | { kind: 'unnamedLanes'; count: number }
  /** Automation channels with the same target and the same curve. */
  | { kind: 'duplicateAutomation'; name: string; count: number };

const DEFAULT_LANE_NAME = /^Track \d+$/;

/** Stacked copies grouped into spans of the song: one issue per run of clips that are stacked the same number of times. */
function stackedIssues(p: Project): SongIssue[] {
  const copies = stackedCopies(p);
  if (!copies.length) return [];
  const clips = p.playlist.clips;
  const spans: { from: Tick; to: Tick; times: number; lanes: Set<LaneId> }[] = [];
  const perKeep = new Map<ClipId, number>();
  for (const c of copies) perKeep.set(c.of, (perKeep.get(c.of) ?? 1) + 1);
  const items = [...perKeep.entries()]
    .map(([keep, times]) => ({ clip: clips[keep]!, times }))
    .sort((a, b) => a.clip.start - b.clip.start);
  for (const { clip, times } of items) {
    const lanes = new Set<LaneId>([clip.laneId]);
    for (const c of copies) if (c.of === clip.id) lanes.add(clips[c.clipId]!.laneId);
    const last = spans[spans.length - 1];
    if (last && clip.start <= last.to && last.times === times) {
      last.to = Math.max(last.to, clip.start + clip.length);
      for (const l of lanes) last.lanes.add(l);
    } else spans.push({ from: clip.start, to: clip.start + clip.length, times, lanes });
  }
  const order = new Map(p.playlist.laneOrder.map((id, i) => [id, i]));
  return spans.map((s) => ({
    kind: 'stacked',
    from: s.from,
    to: s.to,
    times: s.times,
    lanes: [...s.lanes].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
  }));
}

/** Doubled: the same pattern overlapping itself in time, not an exact copy. */
function doubledIssues(p: Project): SongIssue[] {
  const issues: SongIssue[] = [];
  const byPattern = new Map<PatternId, PatternClip[]>();
  for (const c of Object.values(p.playlist.clips)) {
    if (c.kind !== 'pattern' || c.muted) continue;
    const list = byPattern.get(c.patternId) ?? [];
    list.push(c);
    byPattern.set(c.patternId, list);
  }
  for (const [patternId, list] of byPattern) {
    list.sort(byStart);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j]!.start < list[i]!.start + list[i]!.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.start === b.start && a.length === b.length && a.offset === b.offset) continue;
        issues.push({
          kind: 'doubled',
          patternId,
          from: b.start,
          to: Math.min(a.start + a.length, b.start + b.length),
        });
      }
    }
  }
  return issues;
}

/** A pattern clip back to back more than this many times is a repeat worth varying. */
const MAX_PLAIN_REPEATS = 4;

/** Repeats: more than 4 identical clips back to back. */
function repeatIssues(p: Project): SongIssue[] {
  const issues: SongIssue[] = [];
  for (const laneId of p.playlist.laneOrder) {
    for (const r of laneRuns(p, laneId)) {
      if (r.kind !== 'pattern' || r.count <= MAX_PLAIN_REPEATS) continue;
      issues.push({
        kind: 'repeats',
        laneId,
        patternId: r.source as PatternId,
        from: r.from,
        to: r.to,
        count: r.count,
      });
    }
  }
  return issues;
}

/** One issue when tracks that hold clips still have their default "Track N" name. */
function unnamedLaneIssues(p: Project): SongIssue[] {
  const used = new Set(Object.values(p.playlist.clips).map((c) => c.laneId));
  const unnamed = p.playlist.laneOrder.filter(
    (id) => used.has(id) && DEFAULT_LANE_NAME.test(p.playlist.lanes[id]?.name ?? ''),
  ).length;
  return unnamed ? [{ kind: 'unnamedLanes', count: unnamed }] : [];
}

/** Automation channels that are the same curve on the same control. */
function duplicateAutomationIssues(p: Project): SongIssue[] {
  const seen = new Map<string, { name: string; count: number }>();
  for (const ch of Object.values(p.channels)) {
    if (ch.kind !== 'automation') continue;
    const key = automationKey(ch);
    const s = seen.get(key) ?? { name: ch.name, count: 0 };
    s.count++;
    seen.set(key, s);
  }
  return [...seen.values()]
    .filter((s) => s.count > 1)
    .map((s): SongIssue => ({ kind: 'duplicateAutomation', name: s.name, count: s.count }));
}

/** Things in the arrangement that make it sound worse or are hard to work with. */
export function songCheck(p: Project): SongIssue[] {
  return [
    ...stackedIssues(p),
    ...doubledIssues(p),
    ...repeatIssues(p),
    ...unnamedLaneIssues(p),
    ...duplicateAutomationIssues(p),
  ];
}

/** Identifies an automation channel's target and curve (equal keys = interchangeable channels). */
export function automationKey(ch: AutomationChannel): string {
  return JSON.stringify([ch.target, ch.points, ch.range ?? null]);
}

/** A pattern's length, safe on drafts. */
export const patternLengthOf = (p: Project, pid: PatternId): Tick =>
  p.patterns[pid] ? patternLength({ ...p.patterns[pid]! }, p.transport.timeSig) : 0;
