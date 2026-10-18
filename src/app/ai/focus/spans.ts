/** Spans of the song in ticks: cutting a part out of them and merging them. */
import type { PatternId, Project, Tick } from '@core/model/types';
import type { ResolvedFocus } from './types';

/** A stretch of the song. */
export interface Span {
  from: Tick;
  to: Tick;
}

/** The parts of `spans` outside from–to. */
export function spansOutside(spans: readonly Span[], from: Tick, to: Tick): Span[] {
  const outside: Span[] = [];
  for (const span of spans) {
    if (span.from < from) outside.push({ from: span.from, to: Math.min(span.to, from) });
    if (span.to > to) outside.push({ from: Math.max(span.from, to), to: span.to });
  }
  return outside.filter((span) => span.to > span.from);
}

/** Spans that touch or overlap joined into one. */
export function mergedSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  return merged;
}

/** Where a pattern plays outside the part (all its clips, muted ones too: they still count as uses). */
export function usesOutside(project: Project, focus: ResolvedFocus, patternId: PatternId): Span[] {
  const spans: Span[] = [];
  for (const clip of Object.values(project.playlist.clips)) {
    if (clip.kind !== 'pattern' || clip.patternId !== patternId) continue;
    const clipSpan = { from: clip.start, to: clip.start + clip.length };
    if (!focus.clips) spans.push(...spansOutside([clipSpan], focus.from, focus.to));
    else if (!focus.clips.has(clip.id)) spans.push(clipSpan);
  }
  return mergedSpans(spans);
}

/** The patterns that play in the part: clips overlapping its span (or its clips). */
export function partPatterns(project: Project, focus: ResolvedFocus): PatternId[] {
  const seen = new Set<PatternId>();
  for (const clip of Object.values(project.playlist.clips)) {
    if (clip.kind !== 'pattern' || !project.patterns[clip.patternId]) continue;
    const isInside = focus.clips
      ? focus.clips.has(clip.id)
      : clip.start < focus.to && clip.start + clip.length > focus.from;
    if (isInside) seen.add(clip.patternId);
  }
  return project.patternOrder.filter((id) => seen.has(id));
}
