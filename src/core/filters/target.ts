/**
 * What a sound filter applies to: some clips, a span of bars (the loop region, a marker's section,
 * a clicked bar) or the whole song, and which clips of the playlist that means.
 */
import type { Clip, ClipId, MarkerId, Project, Tick } from '../model/types';
import { mutedLanes, songLength } from '../query/playlist';
import { sectionAt, songSections } from '../query/sections';
import { barSpan } from '../time/bars';
import { TICKS_PER_STEP, ticksPerBar } from '../time/ppq';

export type FilterTarget =
  | { kind: 'clips'; clipIds: ClipId[]; from: Tick; to: Tick }
  /** A span of the song on every track; `name` is the section's ("Chorus") when it is one. */
  | { kind: 'range'; from: Tick; to: Tick; name?: string }
  | { kind: 'song'; from: Tick; to: Tick };

/** Clips a filter can render: pattern and audio clips that play (not muted, not on a muted track). */
export function playableClip(p: Project): (c: Clip) => boolean {
  const muted = mutedLanes(p.playlist);
  return (c) => c.kind !== 'automation' && !c.muted && !muted.has(c.laneId);
}

/** These clips (the playable ones), or null when none plays. */
export function clipsTarget(p: Project, ids: readonly ClipId[]): FilterTarget | null {
  const ok = playableClip(p);
  const clips = ids.map((id) => p.playlist.clips[id]).filter((c): c is Clip => !!c && ok(c));
  if (clips.length === 0) return null;
  return {
    kind: 'clips',
    clipIds: clips.map((c) => c.id),
    from: Math.min(...clips.map((c) => c.start)),
    to: Math.max(...clips.map((c) => c.start + c.length)),
  };
}

/** The whole song (null while the playlist is empty). */
export function songTarget(p: Project): FilterTarget | null {
  const end = songLength(p);
  return end > 0 ? { kind: 'song', from: 0, to: end } : null;
}

/** A span of bars on every track (the whole song when it covers it). */
export function rangeTarget(p: Project, from: Tick, to: Tick, name?: string): FilterTarget | null {
  const a = Math.max(0, Math.round(from));
  const b = Math.round(to);
  if (b <= a) return null;
  const end = songLength(p);
  if (a === 0 && end > 0 && b >= end) return { kind: 'song', from: 0, to: end };
  return { kind: 'range', from: a, to: b, ...(name ? { name } : {}) };
}

/** A marker's section. */
export function markerTarget(p: Project, markerId: MarkerId): FilterTarget | null {
  const sec = songSections(p).find((x) => x.markerId === markerId);
  return sec ? rangeTarget(p, sec.from, sec.to, sec.name) : null;
}

/** A clicked spot: the section playing there, else its bar. */
export function spotTarget(p: Project, tick: Tick): FilterTarget | null {
  const sec = sectionAt(p, tick);
  if (sec) return rangeTarget(p, sec.from, sec.to, sec.name);
  const bar = ticksPerBar(p.transport.timeSig);
  const from = Math.floor(Math.max(0, tick) / bar) * bar;
  return rangeTarget(p, from, from + bar);
}

/** True when something plays in the target (a filter there would have something to render). */
export function targetPlays(p: Project, t: FilterTarget): boolean {
  if (t.kind === 'clips') return t.clipIds.length > 0;
  const ok = playableClip(p);
  return Object.values(p.playlist.clips).some((c) => ok(c) && c.start < t.to && c.start + c.length > t.from);
}

/** The usual target:the selected clips, else the loop region, else the whole song. */
export function defaultTarget(
  p: Project,
  ctx: { selection?: readonly ClipId[]; loop?: { start: Tick; end: Tick } | null },
): FilterTarget | null {
  const clips = ctx.selection?.length ? clipsTarget(p, ctx.selection) : null;
  if (clips) return clips;
  if (ctx.loop && ctx.loop.end > ctx.loop.start) return rangeTarget(p, ctx.loop.start, ctx.loop.end);
  return songTarget(p);
}

/** "this clip", "3 clips", "bars 17–32", "“Chorus” (bars 17–32)", "the whole song". */
export function targetLabel(p: Project, t: FilterTarget): string {
  if (t.kind === 'song') return 'the whole song';
  if (t.kind === 'clips') return t.clipIds.length === 1 ? 'this clip' : `${t.clipIds.length} clips`;
  const span = barSpan(t.from, t.to, p.transport.timeSig);
  return t.name ? `“${t.name}” (${span})` : span;
}

export interface FilterPart {
  /** The span that is rendered and replaced, [from, to). */
  from: Tick;
  to: Tick;
  /** The clips it takes (cut at the span's edges). */
  only: (c: Clip) => boolean;
}

/**
 * What a filter replaces. Tone filters on clips take just those clips; everything else takes every
 * playing clip over the span. A speed filter changes the tempo of the span, so it always takes every
 * track (the song stays together), over whole 1/16 steps (the tempo map's resolution).
 */
export function filterPart(p: Project, t: FilterTarget, speed: boolean): FilterPart {
  const ok = playableClip(p);
  if (t.kind === 'clips' && !speed) {
    const ids = new Set(t.clipIds);
    return { from: t.from, to: t.to, only: (c) => ids.has(c.id) && ok(c) };
  }
  if (!speed) return { from: t.from, to: t.to, only: ok };
  const from = Math.floor(t.from / TICKS_PER_STEP) * TICKS_PER_STEP;
  const to = Math.max(from + TICKS_PER_STEP, Math.ceil(t.to / TICKS_PER_STEP) * TICKS_PER_STEP);
  return { from, to, only: ok };
}
