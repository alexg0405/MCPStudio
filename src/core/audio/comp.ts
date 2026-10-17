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
  const now = takeAt(segments, lo, hi);
  if (now === null) return have[dir === 1 ? 0 : have.length - 1] as number;
  const at = have.indexOf(now);
  if (have.length === 1 && at === 0) return null;
  // Not in the list (the playing take has no audio there): the nearest in that direction.
  if (at < 0) {
    const after = have.filter((t) => (dir === 1 ? t > now : t < now));
    return (dir === 1 ? after[0] : after[after.length - 1]) ?? (have[dir === 1 ? 0 : have.length - 1] as number);
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

interface Unit {
  take: number;
  span: CompSpan;
  from: Tick;
  to: Tick;
}

export interface PlanOptions {
  tempo: TempoMap;
  /** Seconds (default 10 ms). */
  crossfadeSec?: number;
}

/**
 * The comp lane's clips for a list of segments. A segment that spans several clips of its take is split
 * at their edges (they are one sound only inside a clip).
 */
export function planComp(segments: readonly CompSegment[], spans: readonly CompSpan[], opts: PlanOptions): CompClipPlan[] {
  const x = Math.max(0, Math.min(MAX_CROSSFADE_MS / 1000, opts.crossfadeSec ?? DEFAULT_CROSSFADE_MS / 1000));
  const units: Unit[] = [];
  for (const seg of normalizeSegments(segments)) {
    for (const span of spans) {
      if (span.index !== seg.take) continue;
      const from = Math.max(seg.from, span.start);
      const to = Math.min(seg.to, end(span));
      if (to > from) units.push({ take: seg.take, span, from, to });
    }
  }
  units.sort((a, b) => a.from - b.from);
  // Overlaps between units of different clips of one take (a damaged group) give way to the earlier one.
  const clean: Unit[] = [];
  for (const u of units) {
    const last = clean[clean.length - 1];
    if (last && u.from < last.to) {
      if (u.to <= last.to) continue;
      clean.push({ ...u, from: last.to });
    } else clean.push(u);
  }
  const sec = (t: Tick) => opts.tempo.tickToSeconds(t);
  // Half-width of the crossfade at each border (0 = a dip, FREE = nothing touches, SEAM = one sound goes on).
  const FREE = -1;
  const SEAM = -2;
  const joins: number[] = [];
  for (let i = 0; i < clean.length - 1; i++) {
    const a = clean[i] as Unit;
    const b = clean[i + 1] as Unit;
    if (a.to !== b.from) {
      joins.push(FREE);
      continue;
    }
    // The same take going on at the same place in its sample (a clip that was split): nothing to blend.
    if (a.take === b.take && Math.abs(a.span.offsetAt(a.to) - b.span.offsetAt(a.to)) < 1e-4) {
      joins.push(SEAM);
      continue;
    }
    const border = a.to;
    let h = halfTicks(opts.tempo, border, x);
    h = Math.min(h, end(a.span) - border, border - b.span.start, Math.floor((a.to - a.from) / 2), Math.floor((b.to - b.from) / 2));
    joins.push(Math.max(0, h));
  }
  const edgeFade = (len: Tick, from: Tick) => Math.min(x, (sec(from + len) - sec(from)) / 2);
  const out: CompClipPlan[] = [];
  for (let i = 0; i < clean.length; i++) {
    const u = clean[i] as Unit;
    const left = i > 0 ? (joins[i - 1] as number) : FREE;
    const right = i < clean.length - 1 ? (joins[i] as number) : FREE;
    const start = left > 0 ? u.from - left : u.from;
    const stop = right > 0 ? u.to + right : u.to;
    const plan: CompClipPlan = { take: u.take, ref: u.span.ref, start, length: stop - start, offsetSec: Math.max(0, u.span.offsetAt(start)) };
    if (u.span.gain !== undefined && u.span.gain !== 1) plan.gain = u.span.gain;
    // Fade-in: the crossfade, a short fade where the comp starts inside a take (or after a gap), or what the take had.
    let fadeIn: number;
    if (left > 0) fadeIn = sec(u.from + left) - sec(u.from - left);
    else if (left === 0) fadeIn = edgeFade(u.to - u.from, u.from);
    else if (left === SEAM) fadeIn = u.from === u.span.start ? (u.span.fadeIn ?? 0) : 0;
    else if (u.from > u.span.start) fadeIn = edgeFade(u.to - u.from, u.from);
    else fadeIn = u.span.fadeIn ?? 0;
    let fadeOut: number;
    if (right > 0) fadeOut = sec(u.to + right) - sec(u.to - right);
    else if (right === 0) fadeOut = edgeFade(u.to - u.from, u.from);
    else if (right === SEAM) fadeOut = u.to === end(u.span) ? (u.span.fadeOut ?? 0) : 0;
    else if (u.to < end(u.span)) fadeOut = edgeFade(u.to - u.from, u.from);
    else fadeOut = u.span.fadeOut ?? 0;
    if (fadeIn > 0) plan.fadeIn = Math.round(fadeIn * 1e6) / 1e6;
    if (fadeOut > 0) plan.fadeOut = Math.round(fadeOut * 1e6) / 1e6;
    out.push(plan);
  }
  return out;
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
    const from = prev && prev.start + prev.length > c.start ? Math.round((prev.start + prev.length + c.start) / 2) : c.start;
    const to = next && c.start + c.length > next.start ? Math.round((c.start + c.length + next.start) / 2) : c.start + c.length;
    if (to > from) segments.push({ take: c.take, from, to });
  }
  return normalizeSegments(segments);
}
