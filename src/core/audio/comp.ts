/**
 * Comping: building one performance out of the takes of a recording. The comp is a list of segments
 * (which take plays where); `planComp` turns it into ordinary audio clips for the comp lane, split at the
 * segments' borders. Where two takes meet, the clips overlap by the crossfade (10 ms by default) centred
 * on the border and fade across it with the clips' own equal-power fades (`envelope.ts`: sin out against
 * cos in, so the power stays level), so playback and export need nothing new. Pure, unit-tested in Node.
 *
 * A border is always symmetric (the earlier clip runs `h` ticks past it, the later one starts `h` ticks
 * before it), so the border is the midpoint of the overlap and `readComp` finds the same segments again
 * from the clips: editing a comp twice does not make it drift.
 */
import type { Tick } from '../model/types';
import type { TempoMap } from '../time/ppq';

/** The default crossfade at a comp's borders. */
export const DEFAULT_CROSSFADE_MS = 10;
/** The longest crossfade at a comp's borders, in milliseconds. */
export const MAX_CROSSFADE_MS = 500;

/** One take's clip: where it plays and how to find its audio. */
export interface CompSpan {
  /** The take (recording order, 0 = the first pass). */
  index: number;
  /** An id the caller uses to find the clip again (a clip id). */
  ref: string;
  start: Tick;
  length: Tick;
  /** Seconds into the sample the clip plays at a song tick (tempo, pitch and reverse included). */
  offsetAt(tick: Tick): number;
  /** The take clip's own gain and fades, which the comp's outer edges inherit. */
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** Part of the comp: take `take` plays from `from` to `to` (song ticks). */
export interface CompSegment {
  take: number;
  from: Tick;
  to: Tick;
}

/** A clip of the comp lane. */
export interface CompClipPlan {
  take: number;
  /** The take clip it plays (`CompSpan.ref`). */
  ref: string;
  start: Tick;
  length: Tick;
  offsetSec: number;
  /** Seconds (absent = none). */
  fadeIn?: number;
  fadeOut?: number;
  gain?: number;
}

const end = (s: CompSpan): Tick => s.start + s.length;

/** Sorts, drops empty segments and joins touching ones of the same take. */
export function normalizeSegments(segments: readonly CompSegment[]): CompSegment[] {
  const sorted = segments
    .filter((s) => s.to > s.from)
    .map((s) => ({ ...s }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const out: CompSegment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from < last.to) {
      // Overlapping input (not produced by the edits here): the later segment wins the overlap.
      if (s.from <= last.from) out.pop();
      else last.to = s.from;
    }
    const prev = out[out.length - 1];
    if (prev && prev.take === s.take && prev.to === s.from) prev.to = s.to;
    else out.push(s);
  }
  return out;
}

/** The parts of [from, to] where `take` has a clip. */
function coverage(spans: readonly CompSpan[], take: number, from: Tick, to: Tick): Array<[Tick, Tick]> {
  const parts: Array<[Tick, Tick]> = [];
  for (const s of spans) {
    if (s.index !== take) continue;
    const a = Math.max(from, s.start);
    const b = Math.min(to, end(s));
    if (b > a) parts.push([a, b]);
  }
  return parts.sort((x, y) => x[0] - y[0]);
}

/** Takes that have a clip, in order. */
export function takeIndexes(spans: readonly CompSpan[]): number[] {
  return [...new Set(spans.map((s) => s.index))].sort((a, b) => a - b);
}

/** Swipes: `take` plays over [from, to] (cut to where it has audio); what played there before is replaced. */
export function swipeSegments(
  segments: readonly CompSegment[],
  spans: readonly CompSpan[],
  take: number,
  from: Tick,
  to: Tick,
): CompSegment[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const parts = coverage(spans, take, lo, hi);
  if (parts.length === 0) return normalizeSegments(segments);
  // Only the covered parts change: where the take has nothing, what played there stays.
  let rest: CompSegment[] = segments.map((s) => ({ ...s }));
  for (const [a, b] of parts) {
    const next: CompSegment[] = [];
    for (const s of rest) {
      if (s.to <= a || s.from >= b) next.push(s);
      else {
        if (s.from < a) next.push({ ...s, to: a });
        if (s.to > b) next.push({ ...s, from: b });
      }
    }
    next.push({ take, from: a, to: b });
    rest = next;
  }
  return normalizeSegments(rest);
}

/**
 * `base` with the parts of `extra` that fall where `base` plays nothing: what another recording's comp played in the
 * gaps of this one stays audible when its takes are added here (nothing of `base` changes).
 */
export function fillGaps(base: readonly CompSegment[], extra: readonly CompSegment[]): CompSegment[] {
  const own = normalizeSegments(base);
  const pieces: CompSegment[] = [];
  for (const segment of normalizeSegments(extra)) {
    let from = segment.from;
    for (const taken of own) {
      if (taken.to <= from || taken.from >= segment.to) continue;
      if (taken.from > from) pieces.push({ take: segment.take, from, to: taken.from });
      from = Math.max(from, taken.to);
    }
    if (from < segment.to) pieces.push({ take: segment.take, from, to: segment.to });
  }
  return normalizeSegments([...own, ...pieces]);
}

/** "Use this take": the whole take plays, in place of the whole comp. */
export function wholeTake(spans: readonly CompSpan[], take: number): CompSegment[] {
  return normalizeSegments(spans.filter((s) => s.index === take).map((s) => ({ take, from: s.start, to: end(s) })));
}

/** The take that plays most of [from, to] in the comp (null when none does). */
export function takeAt(segments: readonly CompSegment[], from: Tick, to: Tick): number | null {
  let best: number | null = null;
  let most = 0;
  for (const s of segments) {
    const overlap = Math.min(s.to, to) - Math.max(s.from, from);
    if (overlap > most) {
      most = overlap;
      best = s.take;
    }
  }
  return best;
}

/**
 * "Next take" / "Previous take" for a range: the take after (or before) the one that plays most of it,
 * going round, among the takes that have audio there. Null when no other take has any.
 */
export function stepTake(
  segments: readonly CompSegment[],
  spans: readonly CompSpan[],
  from: Tick,
  to: Tick,
  dir: 1 | -1,
): number | null {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const have = takeIndexes(spans).filter((t) => coverage(spans, t, lo, hi).length > 0);
  if (have.length === 0) return null;
  // Going round: the first take when stepping forward, the last when stepping back.
  const wrapAround = have[dir === 1 ? 0 : have.length - 1] as number;
  const now = takeAt(segments, lo, hi);
  if (now === null) return wrapAround;
  const at = have.indexOf(now);
  if (have.length === 1 && at === 0) return null;
  // Not in the list (the playing take has no audio there): the nearest in that direction.
  if (at < 0) {
    const after = have.filter((t) => (dir === 1 ? t > now : t < now));
    const nearest = dir === 1 ? after[0] : after[after.length - 1];
    return nearest ?? wrapAround;
  }
  return have[(at + dir + have.length) % have.length] as number;
}

/** The crossfade, in ticks on each side of a border, for a half-length of `halfSec` seconds. */
function halfTicks(tempo: TempoMap, border: Tick, crossfadeSec: number): number {
  const s = tempo.tickToSeconds(border);
  const a = tempo.secondsToTick(s - crossfadeSec / 2);
  const b = tempo.secondsToTick(s + crossfadeSec / 2);
  return Math.round((b - a) / 2);
}

/** The part of one take's clip that a segment plays. */
interface Unit {
  take: number;
  span: CompSpan;
  from: Tick;
  to: Tick;
}

/** What `planComp` needs besides the segments: the tempo map and the crossfade length. */
export interface PlanOptions {
  tempo: TempoMap;
  /** Seconds (default 10 ms). */
  crossfadeSec?: number;
}

/** What lies between two neighbouring units: nothing touching (FREE), one sound that goes on (SEAM), or a crossfade of this half-width in ticks (0 = a dip). */
const FREE = -1;
const SEAM = -2;

/** The parts of the take clips the segments play: a segment that spans several clips of its take is split at their edges. */
function unitsOf(segments: readonly CompSegment[], spans: readonly CompSpan[]): Unit[] {
  const units: Unit[] = [];
  for (const seg of normalizeSegments(segments)) {
    for (const span of spans) {
      if (span.index !== seg.take) continue;
      const from = Math.max(seg.from, span.start);
      const to = Math.min(seg.to, end(span));
      if (to > from) units.push({ take: seg.take, span, from, to });
    }
  }
  return units.sort((a, b) => a.from - b.from);
}

/** Overlaps between units of different clips of one take (a damaged group) give way to the earlier one. */
function withoutOverlaps(units: readonly Unit[]): Unit[] {
  const clean: Unit[] = [];
  for (const u of units) {
    const last = clean[clean.length - 1];
    if (last && u.from < last.to) {
      if (u.to <= last.to) continue;
      clean.push({ ...u, from: last.to });
    } else clean.push(u);
  }
  return clean;
}

/**
 * How each border between neighbouring units is joined: FREE when they do not touch, SEAM when the same take
 * goes on at the same place in its sample (a clip that was split: nothing to blend), else the crossfade's
 * half-width in ticks, limited by what each side has (the clip's audio and half of each unit).
 */
function joinsOf(units: readonly Unit[], tempo: TempoMap, crossfadeSec: number): number[] {
  const joins: number[] = [];
  for (let i = 0; i < units.length - 1; i++) {
    const a = units[i] as Unit;
    const b = units[i + 1] as Unit;
    if (a.to !== b.from) {
      joins.push(FREE);
      continue;
    }
    if (a.take === b.take && Math.abs(a.span.offsetAt(a.to) - b.span.offsetAt(a.to)) < SEAM_OFFSET_TOLERANCE_SEC) {
      joins.push(SEAM);
      continue;
    }
    const border = a.to;
    let h = halfTicks(tempo, border, crossfadeSec);
    h = Math.min(
      h,
      end(a.span) - border,
      border - b.span.start,
      Math.floor((a.to - a.from) / 2),
      Math.floor((b.to - b.from) / 2),
    );
    joins.push(Math.max(0, h));
  }
  return joins;
}

/** Two clips of one take are one sound when their offsets into the sample agree within this many seconds. */
const SEAM_OFFSET_TOLERANCE_SEC = 1e-4;

/** A fade, in seconds, is kept to a microsecond. */
const roundFade = (sec: number) => Math.round(sec * 1e6) / 1e6;

/**
 * The comp clip for a unit: where it starts and stops (extended by the crossfade half-widths), its sample
 * offset, gain and fades. `left` and `right` are how its two borders are joined (see `joinsOf`).
 */
function clipFor(u: Unit, left: number, right: number, sec: (t: Tick) => number, crossfade: number): CompClipPlan {
  const start = left > 0 ? u.from - left : u.from;
  const stop = right > 0 ? u.to + right : u.to;
  const plan: CompClipPlan = {
    take: u.take,
    ref: u.span.ref,
    start,
    length: stop - start,
    offsetSec: Math.max(0, u.span.offsetAt(start)),
  };
  if (u.span.gain !== undefined && u.span.gain !== 1) plan.gain = u.span.gain;
  const edgeFade = Math.min(crossfade, (sec(u.from + (u.to - u.from)) - sec(u.from)) / 2);
  const fadeIn = fadeInOf(u, left, sec, edgeFade);
  const fadeOut = fadeOutOf(u, right, sec, edgeFade);
  if (fadeIn > 0) plan.fadeIn = roundFade(fadeIn);
  if (fadeOut > 0) plan.fadeOut = roundFade(fadeOut);
  return plan;
}

/** The fade-in: the crossfade, a short fade where the comp starts inside a take (or after a gap), or what the take had. */
function fadeInOf(u: Unit, left: number, sec: (t: Tick) => number, edgeFade: number): number {
  if (left > 0) return sec(u.from + left) - sec(u.from - left);
  if (left === 0) return edgeFade;
  if (left === SEAM) return u.from === u.span.start ? (u.span.fadeIn ?? 0) : 0;
  if (u.from > u.span.start) return edgeFade;
  return u.span.fadeIn ?? 0;
}

/** The fade-out, as `fadeInOf` for the end of the unit. */
function fadeOutOf(u: Unit, right: number, sec: (t: Tick) => number, edgeFade: number): number {
  if (right > 0) return sec(u.to + right) - sec(u.to - right);
  if (right === 0) return edgeFade;
  if (right === SEAM) return u.to === end(u.span) ? (u.span.fadeOut ?? 0) : 0;
  if (u.to < end(u.span)) return edgeFade;
  return u.span.fadeOut ?? 0;
}

/**
 * The comp lane's clips for a list of segments. A segment that spans several clips of its take is split
 * at their edges (they are one sound only inside a clip).
 */
export function planComp(
  segments: readonly CompSegment[],
  spans: readonly CompSpan[],
  opts: PlanOptions,
): CompClipPlan[] {
  const crossfade = Math.max(0, Math.min(MAX_CROSSFADE_MS / 1000, opts.crossfadeSec ?? DEFAULT_CROSSFADE_MS / 1000));
  const units = withoutOverlaps(unitsOf(segments, spans));
  const joins = joinsOf(units, opts.tempo, crossfade);
  const sec = (t: Tick) => opts.tempo.tickToSeconds(t);
  return units.map((u, i) => {
    const left = i > 0 ? (joins[i - 1] as number) : FREE;
    const right = i < units.length - 1 ? (joins[i] as number) : FREE;
    return clipFor(u, left, right, sec, crossfade);
  });
}

/**
 * The segments a comp lane's clips make: each clip's core, without the part it shares with a neighbour for
 * the crossfade (the border is the middle of the overlap). Clips are `{ start, length, take }`.
 */
export function readComp(clips: ReadonlyArray<{ start: Tick; length: Tick; take: number }>): CompSegment[] {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const segments: CompSegment[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i] as (typeof sorted)[number];
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const from =
      prev && prev.start + prev.length > c.start ? Math.round((prev.start + prev.length + c.start) / 2) : c.start;
    const to =
      next && c.start + c.length > next.start ? Math.round((c.start + c.length + next.start) / 2) : c.start + c.length;
    if (to > from) segments.push({ take: c.take, from, to });
  }
  return normalizeSegments(segments);
}

/**
 * A hand-made change to a comp clip (its gain or a fade), kept when the comp is rebuilt. Found by comparing
 * a comp lane's clips with what the plan makes of the same segments: only what differs is an edit. `start` and
 * `end` are the clip's extent in song ticks; a fade is carried only to a clip that starts (or ends) at the
 * same tick, a gain to any clip of the same take that overlaps it.
 */
export interface CompEdit {
  take: number;
  start: Tick;
  end: Tick;
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** What a comp clip looks like to the edit finder. */
export interface CompClipLike {
  take: number;
  start: Tick;
  length: Tick;
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
}

const EPS = 1e-6;

function bestOverlap<T extends { take: number; start: Tick }>(
  list: readonly T[],
  endOf: (x: T) => Tick,
  take: number,
  start: Tick,
  stop: Tick,
): T | null {
  let best: T | null = null;
  let most = 0;
  for (const x of list) {
    if (x.take !== take) continue;
    const o = Math.min(stop, endOf(x)) - Math.max(start, x.start);
    if (o > most) {
      most = o;
      best = x;
    }
  }
  return best;
}

/** The hand-made gains and fades of `clips`, measured against `baseline` (the plan of the same segments). */
export function findCompEdits(clips: readonly CompClipLike[], baseline: readonly CompClipPlan[]): CompEdit[] {
  const out: CompEdit[] = [];
  for (const c of clips) {
    const b = bestOverlap(baseline, (x) => x.start + x.length, c.take, c.start, c.start + c.length);
    if (!b) continue;
    const e: CompEdit = { take: c.take, start: c.start, end: c.start + c.length };
    if (Math.abs((c.gain ?? 1) - (b.gain ?? 1)) > EPS) e.gain = c.gain ?? 1;
    if (c.start === b.start && Math.abs((c.fadeIn ?? 0) - (b.fadeIn ?? 0)) > EPS) e.fadeIn = c.fadeIn ?? 0;
    if (c.start + c.length === b.start + b.length && Math.abs((c.fadeOut ?? 0) - (b.fadeOut ?? 0)) > EPS)
      e.fadeOut = c.fadeOut ?? 0;
    if (e.gain !== undefined || e.fadeIn !== undefined || e.fadeOut !== undefined) out.push(e);
  }
  return out;
}

/** The plan with the hand-made edits laid over it (by position, see `CompEdit`). */
export function applyCompEdits(plan: readonly CompClipPlan[], edits: readonly CompEdit[]): CompClipPlan[] {
  if (edits.length === 0) return plan.map((p) => ({ ...p }));
  return plan.map((p) => {
    const out = { ...p };
    const e = bestOverlap(edits, (x) => x.end, p.take, p.start, p.start + p.length);
    if (!e) return out;
    if (e.gain !== undefined) {
      if (Math.abs(e.gain - 1) > EPS) out.gain = e.gain;
      else delete out.gain;
    }
    // A fade belongs to a border: it is kept only where the clip still begins (or ends) at the same tick.
    const set = (key: 'fadeIn' | 'fadeOut', v: number | undefined, same: boolean) => {
      if (v === undefined || !same) return;
      if (v > 0) out[key] = v;
      else delete out[key];
    };
    set('fadeIn', e.fadeIn, p.start === e.start);
    set('fadeOut', e.fadeOut, p.start + p.length === e.end);
    return out;
  });
}

/**
 * Moves the part of the comp that plays `take` between `from` and `to` by `shift` ticks (a take clip that was
 * moved: what the comp plays of it goes with it). Segments and edits are cut at the clip's old edges.
 */
export function shiftTakePart(
  segments: readonly CompSegment[],
  edits: readonly CompEdit[],
  take: number,
  from: Tick,
  to: Tick,
  shift: Tick,
): { segments: CompSegment[]; edits: CompEdit[] } {
  const out: CompSegment[] = [];
  for (const s of segments) {
    if (s.take !== take || s.to <= from || s.from >= to || shift === 0) {
      out.push({ ...s });
      continue;
    }
    const a = Math.max(s.from, from);
    const b = Math.min(s.to, to);
    if (s.from < a) out.push({ ...s, to: a });
    out.push({ take, from: a + shift, to: b + shift });
    if (s.to > b) out.push({ ...s, from: b });
  }
  const moved = edits.map((e) => {
    if (e.take !== take || shift === 0 || (e.start + e.end) / 2 < from || (e.start + e.end) / 2 >= to) return { ...e };
    return { ...e, start: e.start + shift, end: e.end + shift };
  });
  return { segments: out, edits: moved };
}
