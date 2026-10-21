/** The patterns as text: per pattern its channels with note counts and where it plays; and which ones to keep in full. */
import { patternSpans } from '@core/query/arrangement';
import { patternLength } from '@core/query/queries';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import type { Pattern, PatternId, Project } from '@core/model/types';
import { derivedLabel } from '../../arrange/summary';
import { cachedForProject } from './project-cache';
import { noteName } from '../../assistant/context';
import type { ResolvedFocus } from '../focus';
import { FULL_PATTERNS, fullRender, type ContextRender } from './budget';
import { round2 } from './units';

/** Pitch range and count of a pattern's notes, for the patterns the song is not showing in detail. */
function noteSummary(project: Project, pattern: Pattern): string {
  const byPattern = cachedForProject(project, 'note-summaries', () => new Map<PatternId, string>());
  const known = byPattern.get(pattern.id);
  if (known !== undefined) return known;
  const text = writeNoteSummary(project, pattern);
  byPattern.set(pattern.id, text);
  return text;
}

function writeNoteSummary(project: Project, pattern: Pattern): string {
  let count = 0;
  let lowest = Infinity;
  let highest = -Infinity;
  for (const channelId of project.channelOrder) {
    for (const note of Object.values(pattern.notes[channelId] ?? {})) {
      count++;
      lowest = Math.min(lowest, note.key);
      highest = Math.max(highest, note.key);
    }
  }
  if (count === 0) return 'empty';
  const range = lowest === highest ? noteName(lowest) : `${noteName(lowest)}–${noteName(highest)}`;
  return `${count} note${count === 1 ? '' : 's'}, ${range}`;
}

/** The patterns that play inside the focus (the part the request is about), in song order. */
function focusPatterns(project: Project, focus: ResolvedFocus | null): PatternId[] {
  if (!focus) return [];
  if (focus.notes) return [focus.notes.patternId];
  const inside = new Set<PatternId>();
  for (const clip of Object.values(project.playlist.clips)) {
    if (clip.kind !== 'pattern') continue;
    const isInFocus = focus.clips
      ? focus.clips.has(clip.id)
      : clip.start < focus.to && clip.start + clip.length > focus.from;
    if (isInFocus) inside.add(clip.patternId);
  }
  return project.patternOrder.filter((patternId) => inside.has(patternId));
}

/**
 * The patterns kept in full when the project is shortened: the current one, then the ones playing in
 * the focus, then the most used on the playlist, up to `FULL_PATTERNS`.
 */
export function fullPatterns(project: Project, current: PatternId | null, focus: ResolvedFocus | null): Set<PatternId> {
  const uses = new Map<PatternId, number>();
  for (const clip of Object.values(project.playlist.clips)) {
    if (clip.kind === 'pattern') uses.set(clip.patternId, (uses.get(clip.patternId) ?? 0) + 1);
  }
  const position = new Map(project.patternOrder.map((patternId, index) => [patternId, index] as const));
  const byUse = project.patternOrder
    .filter((patternId) => (uses.get(patternId) ?? 0) > 0)
    .sort((a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0) || position.get(a)! - position.get(b)!);
  const kept = new Set<PatternId>();
  for (const patternId of [...(current ? [current] : []), ...focusPatterns(project, focus), ...byUse]) {
    if (kept.size >= FULL_PATTERNS) break;
    if (project.patterns[patternId]) kept.add(patternId);
  }
  return kept;
}

/** The channels with notes in a pattern, as "Name (count)" in rack order (per project version: every render needs them). */
function channelsOf(project: Project, pattern: Pattern): string[] {
  const byPattern = cachedForProject(project, 'pattern-channels', () => new Map<PatternId, string[]>());
  const known = byPattern.get(pattern.id);
  if (known) return known;
  const used = project.channelOrder
    .filter((channelId) => Object.keys(pattern.notes[channelId] ?? {}).length > 0)
    .map(
      (channelId) =>
        `${project.channels[channelId]?.name ?? channelId} (${Object.keys(pattern.notes[channelId] ?? {}).length})`,
    );
  byPattern.set(pattern.id, used);
  return used;
}

/** Each pattern: its channels with note counts, and where it plays in the song. */
export function patternLines(
  project: Project,
  render: ContextRender = fullRender(),
  current: PatternId | null = null,
  full: ReadonlySet<PatternId> | null = null,
): string[] {
  const timeSig = project.transport.timeSig;
  const barTicks = ticksPerBar(timeSig);
  const spans = patternSpans(project);
  const lines: string[] = [];
  for (const patternId of project.patternOrder) {
    const pattern = project.patterns[patternId];
    if (!pattern) continue;
    if (full && patternId !== current && !full.has(patternId)) {
      render.cut.add('patterns');
      lines.push(`- ${pattern.id} · "${pattern.name}"`);
      continue;
    }
    const bars = patternLength(pattern, timeSig) / barTicks;
    const usedChannels = channelsOf(project, pattern);
    const isSummarized = render.shorten.otherNotes && patternId !== current && usedChannels.length > 0;
    if (isSummarized) render.cut.add('patterns');
    let content = usedChannels.length ? usedChannels.join(', ') : 'empty';
    if (isSummarized) content = noteSummary(project, pattern);
    const placed = spans.get(patternId);
    const plays = placed?.length
      ? `plays at ${placed.map((span) => barSpan(span.from, span.to, timeSig)).join(', ')}`
      : 'not in the song';
    const variant = derivedLabel(project, pattern);
    lines.push(
      `- "${pattern.name}" ${pattern.id}, ${round2(bars)} bar${bars === 1 ? '' : 's'}${variant ? ` (${variant})` : ''}: ${content}; ${plays}`,
    );
  }
  return lines;
}
