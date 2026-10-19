import type { Draft } from 'immer';
import { newId } from '../../model/ids';
import type { ClipId, LaneId, PatternClip, PatternId, Project, Tick } from '../../model/types';
import { splitClip } from '../../ops/playlist';
import type { TempoMap } from '../../time/ppq';
import type { VariantEnv } from '../fills';
import { eachNote, lengthOfPattern } from '../notes';
import { eventSpan, stepsForClips, type SongEvent } from '../plan';
import type { Content } from '../plan/section-content';
import { isDrumRole, noteRole } from '../roles';
import { mergeSteps, normalizeStep } from '../variants';
import type { ApplyEnv } from './types';
import { deriveVariant, rootOf } from './variants';

/** Content tick of a clip at a song tick. */
const contentAt = (c: PatternClip, len: Tick, t: Tick) => (((t - c.start + c.offset) % len) + len) % len;

/** Splits a pattern clip so [from, to) falls in pieces that each play one repeat of the pattern. */
function isolate(d: Draft<Project>, clipId: ClipId, from: Tick, to: Tick, len: Tick, tempo: TempoMap): ClipId[] {
  const c = d.playlist.clips[clipId] as Draft<PatternClip> | undefined;
  if (!c || c.kind !== 'pattern') return [];
  // Wrap points (content tick 0) at or before `from` and every one after it up to `to`.
  const first = from - contentAt(c, len, from);
  const cuts: Tick[] = [];
  for (let t = first; t < to; t += len) if (t > c.start && t < c.start + c.length) cuts.push(t);
  const after = first + Math.ceil((to - first) / len) * len;
  if (after > c.start && after < c.start + c.length) cuts.push(after);
  const pieces: ClipId[] = [clipId];
  let current = clipId;
  for (const t of cuts.sort((a, b) => a - b)) {
    const right = newId.clip();
    splitClip(d, current, t, tempo, right);
    pieces.push(right);
    current = right;
  }
  return pieces.filter((id) => {
    const x = d.playlist.clips[id];
    return !!x && x.start < to && x.start + x.length > from;
  });
}

/** The drum and hat notes a clip's pattern plays (to pick the clip a fill goes to). */
function patternContent(p: Project, pid: PatternId, env: VariantEnv): Content {
  const pat = p.patterns[pid];
  let drums = 0;
  let hats = 0;
  let bass808 = 0;
  let bassAny = 0;
  eachNote(pat?.notes ?? {}, (cid, n) => {
    const channelRole = env.roles.get(cid) ?? 'other';
    const role = noteRole(channelRole, n.key);
    if (isDrumRole(role)) drums++;
    if (role === 'hat') hats++;
    if (channelRole === '808') bass808++;
    if (channelRole === '808' || channelRole === 'bass') bassAny++;
  });
  return {
    drums,
    hats,
    bass808,
    bassAny,
    caps: { drums: drums > 0, hats: hats > 0, openHat: false, slide: bass808 > 0 },
  };
}

/** Options that narrow which clips an in-place edit may change. */
export interface InPlaceOptions {
  /** Only clips on these lanes. */
  lanes?: ReadonlySet<LaneId>;
  /** Never clips on these lanes. */
  skipLanes?: ReadonlySet<LaneId>;
  /** Never these clips. */
  protect?: ReadonlySet<ClipId>;
}

/** The unmuted pattern clips under a span that the options allow changing. */
function clipsUnder(p: Project, span: { from: Tick; to: Tick }, opts: InPlaceOptions): PatternClip[] {
  return Object.values(p.playlist.clips).filter(
    (c): c is PatternClip =>
      c.kind === 'pattern' &&
      !c.muted &&
      !!p.patterns[c.patternId] &&
      c.start < span.to &&
      c.start + c.length > span.from &&
      (!opts.lanes || opts.lanes.has(c.laneId)) &&
      !opts.skipLanes?.has(c.laneId) &&
      !opts.protect?.has(c.id),
  );
}

/**
 * Applies one event to the pieces under it: each piece gets its own variant carrying the event,
 * merged with the steps it already had. Adds the clips it changed to `changed`.
 */
function applyEventToPieces(
  d: Draft<Project>,
  event: Omit<SongEvent, 'section'>,
  pieces: readonly PatternClip[],
  env: ApplyEnv,
  changed: Set<ClipId>,
): void {
  const p = d as unknown as Project;
  // (a pattern's content is counted once however many pieces play it)
  const contents = new Map<PatternId, Content>();
  const clips = pieces.map((c) => {
    const { root } = rootOf(p, c.patternId);
    let content = contents.get(c.patternId);
    if (!content) {
      content = patternContent(p, c.patternId, env.variant);
      contents.set(c.patternId, content);
    }
    return { start: c.start, length: c.length, content, section: 0, source: `${c.laneId}|${root}` };
  });
  const stepsPerClip = stepsForClips([{ ...event, section: 0 }], clips);
  pieces.forEach((c, i) => {
    const add = stepsPerClip[i]!;
    if (!add.length) return;
    const length = lengthOfPattern(p, c.patternId);
    const offset = contentAt(c, length, c.start);
    // Steps from stepsForClips are relative to the clip's start; shift them to content ticks.
    const shifted = add.map((s) => normalizeStep({ ...s, from: s.from + offset, to: Math.min(length, s.to + offset) }));
    const { root, steps } = rootOf(p, c.patternId);
    const next = deriveVariant(d, root, mergeSteps(steps, shifted), env.variant);
    if (next === c.patternId) return;
    (d.playlist.clips[c.id] as Draft<PatternClip>).patternId = next;
    changed.add(c.id);
  });
}

/**
 * Applies song events to the clips under them: each clip (split so one repeat changes alone) gets
 * its own variant carrying the event, merged with the steps it already had. Muted clips and clips
 * on `skipLanes` and the `protect`ed ones are left alone. Returns the clips changed.
 */
export function applyEditsInPlace(
  d: Draft<Project>,
  events: readonly Omit<SongEvent, 'section'>[],
  env: ApplyEnv,
  opts: InPlaceOptions = {},
): ClipId[] {
  const p = d as unknown as Project;
  const changed = new Set<ClipId>();
  for (const event of events) {
    const span = eventSpan(event);
    if (span.to <= span.from) continue;
    // Each clip under the event plays one repeat there.
    for (const c of clipsUnder(p, span, opts)) {
      isolate(d, c.id, span.from, span.to, lengthOfPattern(p, c.patternId), env.tempo);
    }
    const pieces = clipsUnder(p, span, opts);
    if (!pieces.length) continue;
    applyEventToPieces(d, event, pieces, env, changed);
  }
  return [...changed];
}
