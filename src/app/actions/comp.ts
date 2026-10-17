/**
 * Comping as user actions: use a take (all of it, or the part you swiped), step to the next or previous take
 * for a range, change the crossfade, flatten, fold or open the stack of takes. One undo step each. Menus,
 * commands, the playlist's comp tool and the AI share these.
 */
import { tempoMapOf } from '@core/automation/tempo';
import { DEFAULT_CROSSFADE_MS } from '@core/audio/comp';
import type { AudioClip, Clip, ClipId, Project, Tick } from '@core/model/types';
import { compSegmentsOf, compSetCrossfade, compStep, compSwipe, compUseTake, flattenComp } from '@core/ops/comp';
import { groupOfClip, takeGroup, takeGroups, type TakeGroup } from '@core/query/takes';
import { ticksPerBar } from '@core/time/ppq';
import type { Services } from '../services';
import { consolidate } from './render-to-audio';

/**
 * The clip under the pointer in the playlist (set by its controller, read here: a key press has no pointer
 * of its own). Not state: nothing redraws when it changes.
 */
export const pointerClip: { id: ClipId | null } = { id: null };

/** The group, take and span a command was asked about. */
export interface CompTarget {
  group: TakeGroup;
  /** The take the clip belongs to (a take clip, or the take a comp clip plays). */
  take: number | null;
  /** The clip's extent, when it came from a clip. */
  span: { from: Tick; to: Tick } | null;
}

function clipTarget(p: Project, clip: Clip | undefined): CompTarget | null {
  if (!clip) return null;
  const g = groupOfClip(p, clip);
  if (!g) return null;
  let span = { from: clip.start, to: clip.start + clip.length };
  // A comp clip stands for its segment: without the part it shares with a neighbour for the crossfade.
  if (clip.kind === 'audio' && clip.take?.comp) {
    const mid = clip.start + clip.length / 2;
    const seg = compSegmentsOf(g).find((x) => x.from <= mid && mid < x.to);
    if (seg) span = { from: seg.from, to: seg.to };
  }
  return { group: g, take: clip.kind === 'audio' && clip.take ? clip.take.index : null, span };
}

/**
 * What a comp command acts on: `{ clip }` or `{ group }` from its args, else the selected clip, the clip under
 * the pointer, or the only take group the song has.
 */
export function compTarget(s: Services, args?: { clip?: unknown; group?: unknown }): CompTarget | null {
  const p = s.doc.getState().project;
  if (typeof args?.clip === 'string') return clipTarget(p, p.playlist.clips[args.clip as ClipId]);
  if (typeof args?.group === 'string') {
    const g = takeGroup(p, args.group);
    return g ? { group: g, take: null, span: null } : null;
  }
  for (const id of s.editor.getState().clipSelection) {
    const t = clipTarget(p, p.playlist.clips[id]);
    if (t) return t;
  }
  if (pointerClip.id) {
    const t = clipTarget(p, p.playlist.clips[pointerClip.id]);
    if (t) return t;
  }
  const all = takeGroups(p);
  return all.length === 1 ? { group: all[0] as TakeGroup, take: null, span: null } : null;
}

/** The range a next/previous-take command works on: the clip's span, a bar range from args, or the group's extent. */
export function compRange(s: Services, t: CompTarget, args?: { from_bar?: unknown; to_bar?: unknown }): { from: Tick; to: Tick } {
  const p = s.doc.getState().project;
  const bar = ticksPerBar(p.transport.timeSig);
  const a = typeof args?.from_bar === 'number' ? args.from_bar : undefined;
  const b = typeof args?.to_bar === 'number' ? args.to_bar : a;
  if (a !== undefined && b !== undefined)
    return { from: Math.max(0, Math.round((Math.min(a, b) - 1) * bar)), to: Math.round(Math.max(a, b) * bar) };
  return t.span ?? { from: t.group.start, to: t.group.end };
}

const takeName = (g: TakeGroup, index: number) => `take ${g.takes.findIndex((x) => x.index === index) + 1}`;

/** "Use this take": the whole take plays (or only [from, to] of it, replacing what played there). */
export function chooseTake(s: Services, groupId: string, take: number, range?: { from: Tick; to: Tick }): boolean {
  const p = s.doc.getState().project;
  const g = takeGroup(p, groupId);
  if (!g || !g.takes.some((t) => t.index === take)) return false;
  const tempo = tempoMapOf(p, 'song');
  const label = range ? `Use ${takeName(g, take)} for part of the comp` : `Use ${takeName(g, take)}`;
  let ids: ClipId[] = [];
  const changed = s.history.transact(label, (d) => {
    ids = range ? compSwipe(d, groupId, take, range.from, range.to, tempo) : compUseTake(d, groupId, take, tempo);
  });
  if (changed) s.editor.getState().selectClips(ids);
  return changed;
}

/** Next (dir 1) or previous (-1) take for a range of the comp. Returns the take now playing there, or null. */
export function stepTakeFor(s: Services, groupId: string, range: { from: Tick; to: Tick }, dir: 1 | -1): number | null {
  const p = s.doc.getState().project;
  const g = takeGroup(p, groupId);
  if (!g) return null;
  const tempo = tempoMapOf(p, 'song');
  let now: number | null = null;
  s.history.transact(dir === 1 ? 'Next take' : 'Previous take', (d) => {
    now = compStep(d, groupId, range.from, range.to, dir, tempo);
  });
  if (now !== null) {
    const after = takeGroup(s.doc.getState().project, groupId);
    s.editor.getState().selectClips(after?.comp.filter((c) => c.start < range.to && c.start + c.length > range.from).map((c) => c.id) ?? []);
  }
  return now;
}

/** The crossfade at the comp's borders, in milliseconds (the comp is rebuilt with it). */
export function setCrossfade(s: Services, groupId: string, ms: number): boolean {
  const p = s.doc.getState().project;
  const g = takeGroup(p, groupId);
  if (!g?.compLane) return false;
  const tempo = tempoMapOf(p, 'song');
  return s.history.transact(`Crossfade ${Math.round(ms * 10) / 10} ms`, (d) => compSetCrossfade(d, groupId, ms, tempo));
}

/**
 * Flatten: the comp stays as ordinary clips and the take lanes go. With `merge`, the comp is also rendered into
 * one new clip (the existing consolidate path), all one undo step.
 */
export async function flatten(s: Services, groupId: string, merge: boolean): Promise<boolean> {
  const g = takeGroup(s.doc.getState().project, groupId);
  if (!g) return false;
  if (!merge) return s.history.transact('Flatten comp', (d) => void flattenComp(d, groupId));
  if (g.comp.length === 0) return false;
  await consolidate(s, g.comp as AudioClip[]);
  const cursor = s.history.status().cursor;
  s.history.transact('Flatten comp', (d) => void flattenComp(d, groupId), { amend: cursor });
  return true;
}

/** Opens or closes the stack of take lanes under the comp lane. */
export function setTakesOpen(s: Services, groupId: string, open?: boolean): boolean {
  const ed = s.editor.getState();
  const now = ed.openTakes.includes(groupId);
  ed.setTakesOpen(groupId, open ?? !now);
  return open ?? !now;
}

/** "3 takes · the comp plays take 2 of bars 1–2…": for toasts and the AI. */
export function describeGroup(p: Project, g: TakeGroup): string {
  return `${g.takes.length} take${g.takes.length === 1 ? '' : 's'}, crossfade ${g.crossfadeMs ?? DEFAULT_CROSSFADE_MS} ms`;
}
