/** Resolving a captured focus against the project as it is now, and checking a restored one is well-formed. */
import type { Clip, PatternId, Project } from '@core/model/types';
import { patternLength } from '@core/query/queries';
import { songSections } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import { plural, type AiFocus, type FocusCopies, type ResolvedFocus } from './types';

/** What a resolved focus has before its kind fills in the rest. */
const NO_SECTION_CLIPS_OR_NOTES = { section: null, clips: null, notes: null } as const;

/** The copies that still exist (both patterns are there and differ). */
function validCopies(project: Project, copies: FocusCopies | undefined): Map<PatternId, PatternId> {
  const valid = new Map<PatternId, PatternId>();
  for (const [original, copy] of Object.entries(copies ?? {}) as [PatternId, PatternId][]) {
    if (project.patterns[original] && project.patterns[copy] && original !== copy) valid.set(original, copy);
  }
  return valid;
}

/** The copies as a plain object for storing (undefined when there are none). */
const plainCopies = (copies: ReadonlyMap<PatternId, PatternId>): FocusCopies | undefined =>
  copies.size ? (Object.fromEntries(copies) as FocusCopies) : undefined;

/** A range or section: a section follows its marker, and keeps its bars as a range when the marker is gone. */
function resolveSpanFocus(
  project: Project,
  focus: Extract<AiFocus, { kind: 'range' | 'section' }>,
): ResolvedFocus | null {
  const timeSig = project.transport.timeSig;
  const copies = validCopies(project, focus.copies);
  const section =
    focus.kind === 'section'
      ? songSections(project).find((candidate) => candidate.markerId === focus.markerId)
      : undefined;
  const from = Math.max(0, Math.round(section?.from ?? focus.from));
  const to = Math.round(section?.to ?? focus.to);
  if (!(to > from)) return null;
  const span = barSpan(from, to, timeSig);
  const kept = plainCopies(copies);
  const copiesField = kept ? { copies: kept } : {};
  const resolved: AiFocus = section
    ? { kind: 'section', markerId: section.markerId, from, to, projectId: focus.projectId, ...copiesField }
    : { kind: 'range', from, to, projectId: focus.projectId, ...copiesField };
  return {
    ...NO_SECTION_CLIPS_OR_NOTES,
    focus: resolved,
    from,
    to,
    label: section ? `${section.name} · ${span}` : span,
    short: span,
    section: section ?? null,
    copies,
  };
}

/** The name of a clips focus: "“Drop” clip" for one clip, "3 clips" for several. */
function clipsFocusName(project: Project, clips: readonly Clip[]): string {
  const only = clips.length === 1 ? clips[0]! : null;
  if (!only) return plural(clips.length, 'clip');
  if (only.kind === 'pattern') return `“${project.patterns[only.patternId]?.name ?? 'pattern'}” clip`;
  return `“${project.channels[only.channelId]?.name ?? only.kind}” clip`;
}

/** Some clips: the ones that still exist. */
function resolveClipsFocus(project: Project, focus: Extract<AiFocus, { kind: 'clips' }>): ResolvedFocus | null {
  const ids = focus.clipIds.filter((id) => project.playlist.clips[id]);
  if (ids.length === 0) return null;
  const clips = ids.map((id) => project.playlist.clips[id]!);
  const from = Math.min(...clips.map((clip) => clip.start));
  const to = Math.max(...clips.map((clip) => clip.start + clip.length));
  const span = barSpan(from, to, project.transport.timeSig);
  const copies = validCopies(project, focus.copies);
  const kept = plainCopies(copies);
  return {
    ...NO_SECTION_CLIPS_OR_NOTES,
    focus: { kind: 'clips', clipIds: ids, projectId: focus.projectId, ...(kept ? { copies: kept } : {}) },
    from,
    to,
    label: `${clipsFocusName(project, clips)} · ${span}`,
    short: span,
    clips: new Set(ids),
    copies,
  };
}

/** Some notes of a channel in a pattern: the ones that still exist. */
function resolveNotesFocus(project: Project, focus: Extract<AiFocus, { kind: 'notes' }>): ResolvedFocus | null {
  const pattern = project.patterns[focus.patternId];
  const channel = project.channels[focus.channelId];
  if (!pattern || !channel) return null;
  const notes = pattern.notes[focus.channelId] ?? {};
  const ids = focus.noteIds.filter((id) => notes[id]);
  if (ids.length === 0) return null;
  const count = plural(ids.length, 'note');
  return {
    ...NO_SECTION_CLIPS_OR_NOTES,
    focus: { ...focus, noteIds: ids },
    from: 0,
    to: patternLength(pattern, project.transport.timeSig),
    label: `${count} of “${channel.name}”`,
    short: count,
    notes: { patternId: focus.patternId, channelId: focus.channelId, ids: new Set(ids) },
    copies: new Map(),
  };
}

/**
 * The focus as it is now, or null when it no longer means anything here: another project, clips or
 * notes that were all deleted, an empty span. A section follows its marker; when the marker is gone
 * the focus keeps the bars it had (as a range).
 */
export function resolveFocus(project: Project, focus: AiFocus | null | undefined): ResolvedFocus | null {
  if (!focus || focus.projectId !== project.projectId) return null;
  switch (focus.kind) {
    case 'range':
    case 'section':
      return resolveSpanFocus(project, focus);
    case 'clips':
      return resolveClipsFocus(project, focus);
    case 'notes':
      return resolveNotesFocus(project, focus);
  }
}

/** "Verse · bars 17–32", "3 clips · bars 37–42", "6 notes of “Lead”". */
export function focusLabel(project: Project, focus: AiFocus): string {
  return resolveFocus(project, focus)?.label ?? 'a part that is no longer there';
}

/** Whether a value is a well-formed focus (restoring the tab's state). */
export function isAiFocus(value: unknown): value is AiFocus {
  if (typeof value !== 'object' || value === null) return false;
  const focus = value as Record<string, unknown>;
  const isId = (x: unknown) => typeof x === 'string' && x.length > 0;
  const isTick = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const isIdList = (x: unknown) => Array.isArray(x) && x.length > 0 && x.every(isId);
  const isCopies = (x: unknown) =>
    x === undefined ||
    (typeof x === 'object' &&
      x !== null &&
      Object.entries(x).every(([original, copy]) => isId(original) && isId(copy)));
  const isForwardSpan = () => isTick(focus.from) && isTick(focus.to) && (focus.to as number) > (focus.from as number);
  if (!isId(focus.projectId)) return false;
  switch (focus.kind) {
    case 'range':
      return isForwardSpan() && isCopies(focus.copies);
    case 'section':
      return isId(focus.markerId) && isForwardSpan() && isCopies(focus.copies);
    case 'clips':
      return isIdList(focus.clipIds) && isCopies(focus.copies);
    case 'notes':
      return isId(focus.patternId) && isId(focus.channelId) && isIdList(focus.noteIds);
    default:
      return false;
  }
}
