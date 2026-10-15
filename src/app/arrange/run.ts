/**
 * The arranger's operations on a draft (inside one History recipe), shared by the AI actions
 * (`ops/arrange.ts`) and the playlist's commands: arrange a song from sections, develop an existing
 * one in place, one transition at a bar, one variation at a spot, refresh variants. Each returns
 * change lines for the chat or a toast, the span it edited and what the arrangement check found.
 */
import type { Draft } from 'immer';
import {
  applyArrangement,
  applyEditsInPlace,
  deriveVariant,
  laneAllocatorFor,
  moveLoopCrashes,
  placeAutomation,
  placeCrashes,
  placeFx,
  refreshVariants,
  rootOf,
} from '@core/arrange/apply';
import { existingFx, fillLikeClips, inferSections, layeredFills, loopingPatterns, type InferredSection } from '@core/arrange/infer';
import { lengthOfPattern } from '@core/arrange/notes';
import { FILL_ROTATION } from '@core/arrange/phrases';
import { loopStartCrashes, planArrangement, planDevelop, type ArrangementPlan, type PlannedAutomation, type SongEvent } from '@core/arrange/plan';
import { CRASH_LANE, FX_LANE } from '@core/arrange/plan';
import type { SectionSpec } from '@core/arrange/sections';
import {
  boundaryRecipe,
  classifyBoundary,
  riserBars,
  type AutomationItem,
  type BoundaryKind,
  type EndingKind,
  type FxLevel,
  type FxPlacement,
} from '@core/arrange/transitions';
import { inferStyle, type Style } from '@core/beat/style';
import { fxBeats } from '@core/model/fx';
import type { ChannelId, ClipId, InsertId, LaneId, PatternId, Project, Tick, VariantKind, VariantStep } from '@core/model/types';
import { tidySong } from '@core/ops/tidy';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import { setupMix } from '../mix/setup';
import type { Services } from '../services';
import { checkArrangement, type Finding } from './check';
import { applyEnvFor, rolesOf } from './env';
import { arrangeSummary } from './summary';

const BEAT = 960;

/** An input the arranger can't use (the message says why, for the chat or a toast). */
export class ArrangeInputError extends Error {}

export interface RunResult {
  /** Lines for the chat or a toast (the first one sums it up). */
  changes: string[];
  warnings: string[];
  /** The song span it edited. */
  touched: { from: Tick; to: Tick } | null;
  clipIds: ClipId[];
  findings: Finding[];
}

/** Called with each span before anything changes (a part of the song the musician chose refuses others). */
export type SpanGuard = (from: Tick, to: Tick, what: string) => void;

export interface ArrangeInput {
  /** Where the first section starts (default: bar 1, or after the song when not replacing). */
  from?: Tick;
  replace: boolean;
  style?: Style;
  sections: SectionSpec[];
  fx: FxLevel;
  mix: 'auto' | 'keep';
  ending: 'auto' | EndingKind;
  /** Mixer tracks and channels whose levels were set on purpose (the mix setup leaves them). */
  pinned?: { inserts?: ReadonlySet<InsertId>; channels?: ReadonlySet<ChannelId> };
}

const lineOf = (p: Project, from: Tick, to: Tick) => barSpan(from, to, p.transport.timeSig);

/** Lays out a song from sections (see `planArrangement`), sets up the mix with `mix: 'auto'`. */
export function arrangeInDraft(d: Draft<Project>, s: Services, base: Project, input: ArrangeInput, guard?: SpanGuard): RunResult & { plan: ArrangementPlan; style: Style } {
  const p = d as unknown as Project;
  const style = input.style ?? inferStyle(p);
  const bar = ticksPerBar(p.transport.timeSig);
  const songEnd = Object.values(p.playlist.clips).reduce((m, c) => Math.max(m, c.start + c.length), 0);
  const from = input.from ?? (input.replace ? 0 : Math.ceil(songEnd / bar) * bar);
  const total = input.sections.reduce((n, x) => n + x.bars, 0) * bar;
  guard?.(from, from + total, 'arrange');
  const changes: string[] = [];
  let layout;
  if (input.mix === 'auto') {
    const mix = setupMix(d, s, {
      style,
      roles: rolesOf(p),
      mode: 'rebuild',
      ...(input.pinned?.inserts ? { pinned: input.pinned.inserts } : {}),
      ...(input.pinned?.channels ? { pinnedChannels: input.pinned.channels } : {}),
    });
    layout = mix.layout;
    changes.push(...mix.changes);
  }
  const { env, changes: made } = applyEnvFor(d, s, base, style, { create: input.mix === 'auto', ...(layout ? { layout } : {}) });
  const plan = planArrangement(p, { from, style, sections: input.sections, fx: input.fx, ending: input.ending }, { variant: env.variant });
  // A whole song (from bar 1, no bar given) replaces the whole song; otherwise its own bars.
  const replaceTo = input.from === undefined && input.replace ? Math.max(plan.to, Math.ceil(songEnd / bar) * bar) : plan.to;
  const report = applyArrangement(d, plan, env, { replace: input.replace, replaceTo });
  const findings = checkArrangement(s, p, { style, sections: plan.sections });
  const extra: string[] = [];
  for (const m of report.movedCrashes)
    extra.push(`Moved the crash at the start of “${p.patterns[m.patternId]?.name ?? 'a beat'}” into crash hits (it crashed on every loop)`);
  return {
    plan,
    style,
    changes: [arrangeSummary(plan), ...made, ...changes, ...extra],
    warnings: findings.filter((f) => f.severity === 'bug').map((f) => `arrangement check: ${f.message}`),
    touched: { from: plan.from, to: plan.to },
    clipIds: report.clipIds,
    findings,
  };
}

export interface DevelopInput {
  from?: Tick;
  to?: Tick;
  fills: boolean;
  transitions: boolean;
  fx: boolean;
  cleanup: boolean;
  style?: Style;
}

/** A plain count: "1 fill", "3 fills". */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Develops a song in place: optional cleanup (stacked copies; fills on their own track replace the
 * drums under them), phrase fills and small changes, transitions with gaps, FX, crashes and sweeps,
 * keeping what is already there (FX within a beat, crashes within 4 bars, fills from their own clips).
 */
export function developInDraft(d: Draft<Project>, s: Services, base: Project, input: DevelopInput, guard?: SpanGuard): RunResult {
  const p = d as unknown as Project;
  const style = input.style ?? inferStyle(p);
  const bar = ticksPerBar(p.transport.timeSig);
  const songEnd = Object.values(p.playlist.clips).reduce((m, c) => Math.max(m, c.start + c.length), 0);
  const from = Math.max(0, input.from ?? 0);
  const to = Math.min(input.to ?? songEnd, Math.ceil(songEnd / bar) * bar);
  if (to <= from) return { changes: ['There is nothing to develop there (the playlist is empty)'], warnings: [], touched: null, clipIds: [], findings: [] };
  guard?.(from, to, 'develop');
  const changes: string[] = [];
  const { env, changes: made } = applyEnvFor(d, s, base, style, { create: input.fx && input.transitions });
  if (input.cleanup) {
    // The whole song gets the whole clean-up; a part of it only loses its stacked copies.
    const whole = from === 0 && to >= songEnd;
    const r = tidySong(d, whole ? {} : { automation: false, names: false, range: { from, to } });
    if (r.stacked) changes.push(`Removed ${count(r.stacked, 'stacked copy', 'stacked copies')} (parts playing on top of themselves)`);
    if (r.automation) changes.push(`Merged ${count(r.automation, 'repeated automation channel')}`);
    if (r.named.length) changes.push(`Named ${count(r.named.length, 'track')} after what they play`);
    // A crash on the first beat of a loop crashes every few bars: it moves out of the patterns
    // that loop here and nowhere else (their variants follow), and crashes mark the sections instead.
    const looping = loopingPatterns(p);
    const inRange = new Set<PatternId>();
    const outside = new Set<PatternId>();
    for (const c of Object.values(p.playlist.clips)) {
      if (c.kind !== 'pattern') continue;
      const root = rootOf(p, c.patternId).root;
      (c.start >= from && c.start + c.length <= to ? inRange : outside).add(root);
    }
    const moves = [...inRange]
      .filter((pid) => !outside.has(pid) && looping.has(pid) && !p.patterns[pid]?.derived && lengthOfPattern(p, pid) <= 4 * bar)
      .flatMap((pid) => loopStartCrashes(p, pid, env.variant).map((m) => ({ patternId: pid, ...m })));
    const moved = moveLoopCrashes(d, { loopCrashes: moves });
    if (moved.length) {
      refreshVariants(d, env.variant, new Set(moved.map((m) => m.patternId)));
      changes.push(
        `Moved the crash on the first beat of ${moved.map((m) => `“${p.patterns[m.patternId]?.name ?? '?'}”`).join(', ')} out (it crashed on every loop; crashes now mark the sections)`,
      );
    }
    // Fills on their own track replace the drums under them instead of piling on.
    const layered = layeredFills(p, env.variant).filter((l) => l.fill.from < to && l.fill.to > from);
    const fillClips = new Set(fillLikeClips(p, env.variant).map((f) => f.clipId));
    for (const l of layered)
      applyEditsInPlace(d, [{ kind: 'clear-drums', from: l.fill.from, to: l.fill.to, energy: 4, why: 'end' }], env, {
        skipLanes: new Set([l.fill.laneId]),
        protect: fillClips,
      });
    if (layered.length)
      changes.push(
        `${layered.length === 1 ? 'The fill' : `${layered.length} fills`} on their own track (${layered
          .map((l) => `bar ${l.fill.from / bar + 1}`)
          .slice(0, 6)
          .join(', ')}) now replace the drums under them`,
      );
  }
  const sections = inferSections(p, env.variant);
  const fillClips = fillLikeClips(p, env.variant);
  const fills = fillClips.map((f) => ({ from: f.from, to: f.to }));
  const plan = planDevelop(
    p,
    sections,
    { style, fills: input.fills, transitions: input.transitions, fx: input.fx ? 'auto' : 'none', from, to },
    { fx: existingFx(p, env.variant), fills },
    laneAllocatorFor(p),
  );
  // Elements reaching far outside the range are left out (a part of the song stays a part).
  const near = (a: Tick, b: Tick) => a >= from - bar && b <= to + bar;
  // Fills playing from their own clips are the musician's: nothing changes them.
  const changed = applyEditsInPlace(d, plan.events, env, { protect: new Set(fillClips.map((f) => f.clipId)) });
  const fx = placeFx(d, plan.fx.filter((f) => near(f.start, f.start + Math.min(f.length, bar))), env);
  const crashes = placeCrashes(d, plan.crashes.filter((c) => near(c.at, c.at)), env);
  const automation = placeAutomation(d, plan.automation.filter((a) => near(a.start, a.start + a.length)), env, { skipBusy: true });
  const findings = checkArrangement(s, p, { style });
  const builds = plan.counts.builds;
  const summary = [
    plan.counts.fills ? count(plan.counts.fills, 'fill') : '',
    builds.length ? `${count(builds.length, 'build')} (gap${builds.some((b) => b.riser) ? ', riser' : ''}${builds.some((b) => b.impact) ? ', impact' : ''})` : '',
    plan.counts.breakdowns ? count(plan.counts.breakdowns, 'breakdown') : '',
    fx.length ? count(fx.length, 'FX sound') : '',
    crashes.length ? count(crashes.length, 'crash', 'crashes') : '',
    automation.length ? count(automation.length, 'sweep') : '',
  ].filter(Boolean);
  const kept = plan.skipped.fx + plan.skipped.fills;
  return {
    changes: [
      `Developed ${lineOf(p, from, to)}: ${summary.join(', ') || 'nothing needed'}${kept ? ` (kept ${count(kept, 'fill or FX', 'fills and FX')} already there)` : ''}`,
      ...changes,
      ...made,
      ...(changed.length ? [`${count(changed.length, 'clip')} now play${changed.length === 1 ? 's' : ''} a variant`] : []),
    ],
    warnings: [],
    touched: { from, to },
    clipIds: [...changed, ...fx, ...crashes, ...automation],
    findings,
  };
}

export const TRANSITION_KINDS = [
  'auto',
  'rise',
  'lift',
  'same',
  'dip',
  'fall',
  'fill',
  'gap',
  'riser',
  'reverse_crash',
  'impact',
  'downlifter',
  'crash',
  'filter_open',
  'filter_close',
  'reverb_throw',
] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export interface TransitionInput {
  /** The downbeat it leads into. */
  at: Tick;
  kind: TransitionKind;
  /** Riser, downlifter and filter lengths. */
  bars?: number;
  /** Fill and gap lengths. */
  beats?: number;
  style?: Style;
}

/** The sections on both sides of `at` (one section split there when `at` falls inside it). */
function sidesAt(sections: readonly InferredSection[], at: Tick): { a: InferredSection | null; b: InferredSection } | null {
  const bi = sections.findIndex((x) => x.from === at);
  if (bi >= 0) return { a: bi > 0 ? sections[bi - 1]! : null, b: sections[bi]! };
  const inside = sections.find((x) => x.from < at && at < x.to);
  if (!inside) return null;
  const bars = (t: Tick) => (t - inside.from) / ((inside.to - inside.from) / inside.bars);
  return {
    a: { ...inside, to: at, bars: Math.max(1, Math.round(bars(at))) },
    b: { ...inside, from: at, bars: Math.max(1, inside.bars - Math.round(bars(at))) },
  };
}

/** One transition at a bar: a whole recipe (auto or a kind), or one element of one. */
export function transitionInDraft(d: Draft<Project>, s: Services, base: Project, input: TransitionInput, guard?: SpanGuard): RunResult {
  const p = d as unknown as Project;
  const style = input.style ?? inferStyle(p);
  const bar = ticksPerBar(p.transport.timeSig);
  const bpb = p.transport.timeSig.num * (4 / p.transport.timeSig.den);
  const X = Math.max(0, Math.round(input.at / BEAT) * BEAT);
  const { env, changes: made } = applyEnvFor(d, s, base, style, { create: true });
  const sections = inferSections(p, env.variant);
  const sides = sidesAt(sections, X);
  const ctx = { bpm: p.transport.bpm, beatsPerBar: bpb, barTicks: bar, style, fx: 'auto' as const };
  let events: Omit<SongEvent, 'section'>[] = [];
  let fx: FxPlacement[] = [];
  let crash: number | null = null;
  let automation: AutomationItem[] = [];
  let what: string = input.kind.replace(/_/g, ' ');
  const beats = (n: number) => Math.max(1, Math.min(16, Math.round(input.beats ?? n)));
  const barsOf = (n: number) => Math.max(1, Math.min(8, Math.round(input.bars ?? n)));
  if (['auto', 'rise', 'lift', 'same', 'dip', 'fall'].includes(input.kind)) {
    if (!sides) return { changes: [], warnings: [`there is no section at bar ${X / bar + 1} to lead into`], touched: null, clipIds: [], findings: [] };
    const kind: BoundaryKind = input.kind === 'auto' ? classifyBoundary(sides.a, sides.b) : (input.kind as BoundaryKind);
    const r = boundaryRecipe(kind, X, sides.a ? { ...sides.a, fill: 'auto' } : null, sides.b, ctx, { fill: 0 });
    events = r.end.map((e) => ({ ...e, from: e.from + (sides.a?.from ?? X), to: e.to + (sides.a?.from ?? X) }));
    fx = r.fx;
    crash = r.crash;
    automation = r.automation;
    what = `a ${kind} into “${sides.b.name}”`;
  } else {
    const fillKind: VariantKind = FILL_ROTATION[style][0]!;
    switch (input.kind) {
      case 'fill':
        events = [{ kind: fillKind, from: X - beats(2) * BEAT, to: X, energy: sides?.a?.energy ?? 4, why: 'end' }];
        break;
      case 'gap':
        events = [{ kind: 'gap', from: X - beats(1) * BEAT, to: X, energy: 4, why: 'end' }];
        break;
      case 'riser': {
        const n = barsOf(riserBars(p.transport.bpm, bpb)) * bpb;
        fx = [{ kind: 'riser', beats: n, start: X - n * BEAT, gainDb: -4 }];
        break;
      }
      case 'reverse_crash':
        fx = [{ kind: 'reverse-crash', beats: beats(4), start: X - beats(4) * BEAT, gainDb: -3 }];
        break;
      case 'impact':
        fx = [{ kind: 'impact', beats: fxBeats('impact', p.transport.bpm), start: X, gainDb: -2 }];
        break;
      case 'downlifter':
        fx = [{ kind: 'downlifter', beats: barsOf(1) * bpb, start: X, gainDb: -8 }];
        break;
      case 'crash':
        crash = 0.95;
        break;
      case 'filter_open':
      case 'filter_close':
      case 'reverb_throw': {
        const len = input.kind === 'reverb_throw' ? BEAT : barsOf(input.kind === 'filter_open' ? 4 : 2) * bar;
        const start = input.kind === 'filter_open' ? X : X - len;
        for (const bus of input.kind === 'reverb_throw' ? (['chords'] as const) : (['chords', 'lead'] as const))
          automation.push(
            input.kind === 'reverb_throw'
              ? {
                  purpose: 'throw',
                  target: { kind: 'throw' },
                  start,
                  length: len,
                  points: [
                    { at: 0, value: 'throw' },
                    { at: len, value: 'throw' },
                    { at: len, value: 'neutral' },
                  ],
                }
              : input.kind === 'filter_open'
                ? {
                    purpose: 'filter-open',
                    target: { kind: 'eq', bus, band: 'high-cut' },
                    start,
                    length: len,
                    points: [
                      { at: 0, value: 1200, tension: 0.35 },
                      { at: len, value: 'neutral' },
                    ],
                  }
                : {
                    purpose: 'filter-open',
                    target: { kind: 'eq', bus, band: 'high-cut' },
                    start,
                    length: len,
                    points: [
                      { at: 0, value: 'neutral', tension: -0.35 },
                      { at: len, value: 900 },
                      { at: len, value: 'neutral' },
                    ],
                  },
          );
        break;
      }
    }
  }
  const lo = Math.min(X, ...events.map((e) => e.from), ...fx.map((f) => f.start), ...automation.map((a) => a.start));
  const hi = Math.max(X, ...events.map((e) => e.to), ...automation.map((a) => a.start + a.length));
  guard?.(Math.max(0, lo), hi, 'transition');
  const changed = applyEditsInPlace(d, events, env);
  const lanes = laneAllocatorFor(p);
  const there = existingFx(p, env.variant);
  const fxClips = placeFx(
    d,
    fx
      .filter((f) => {
        const at = f.kind === 'riser' || f.kind === 'reverse-crash' ? f.start + f.beats * BEAT : f.start;
        return f.start >= 0 && !there.some((x) => x.kind === f.kind && Math.abs(x.at - at) <= BEAT);
      })
      .map((f) => ({ ...f, length: Math.round(f.beats * BEAT), lane: lanes.place(FX_LANE[f.kind], f.start, f.start + f.beats * BEAT) })),
    env,
  );
  const crashClips =
    crash !== null && !there.some((x) => x.kind === 'crash' && Math.abs(x.at - X) <= BEAT)
      ? placeCrashes(d, [{ at: X, velocity: crash, lane: lanes.place(CRASH_LANE, X, X + 4 * bar) }], env)
      : [];
  const autoClips = placeAutomation(
    d,
    automation.filter((a) => a.start >= 0).map((a): PlannedAutomation => ({ ...a, lane: lanes.place('Automation', a.start, a.start + a.length) })),
    env,
    { skipBusy: true },
  );
  const n = changed.length + fxClips.length + crashClips.length + autoClips.length;
  return {
    changes: n ? [`Added ${what} at bar ${X / bar + 1}`, ...made] : [`${what[0]!.toUpperCase()}${what.slice(1)} at bar ${X / bar + 1}: already there (nothing added)`],
    warnings: [],
    touched: { from: Math.max(0, lo), to: hi },
    clipIds: [...changed, ...fxClips, ...crashClips, ...autoClips],
    findings: [],
  };
}

export const VARY_KINDS = ['fill', 'hat_roll', '808_slide', 'dropout', 'stutter', 'thin', 'double_hats', 'without', 'crash'] as const;
export type VaryKind = (typeof VARY_KINDS)[number];

export interface VaryInput {
  kind: VaryKind;
  /** The bar whose end gets the change (crash: whose start). */
  bar?: number;
  fromBar?: number;
  toBar?: number;
  /** Make a variant of this pattern instead (not placed). */
  pattern?: PatternId;
  lane?: LaneId;
  /** without: channel ids or parts. */
  parts?: string[];
  beats?: number;
  level?: number;
  style?: Style;
}

/** One variation at a spot (or over bars), or a variant of a pattern. Returns the variant made for a pattern. */
export function varyInDraft(
  d: Draft<Project>,
  s: Services,
  base: Project,
  input: VaryInput,
  guard?: SpanGuard,
): RunResult & { variant?: PatternId } {
  const p = d as unknown as Project;
  const style = input.style ?? inferStyle(p);
  const bar = ticksPerBar(p.transport.timeSig);
  const { env } = applyEnvFor(d, s, base, style, { create: false });
  const beats = Math.max(1, Math.min(8, Math.round(input.beats ?? (input.kind === 'fill' ? 2 : input.kind === 'dropout' ? 2 : 1))));
  const kindOf: Record<Exclude<VaryKind, 'crash'>, VariantKind> = {
    fill: FILL_ROTATION[style][0]!,
    hat_roll: 'hat-roll',
    '808_slide': 'slide',
    dropout: 'dropout',
    stutter: 'stutter',
    thin: 'thin',
    double_hats: 'double-hats',
    without: 'without',
  };
  const whole = input.kind === 'thin' || input.kind === 'double_hats' || input.kind === 'without';
  const extra: Partial<VariantStep> = {};
  if (input.kind === 'thin') extra.level = input.level ?? 1;
  if (input.kind === 'without') extra.parts = input.parts ?? [];
  if (input.kind === 'without' && !extra.parts!.length) throw new ArrangeInputError('without needs the channels or parts to leave out');
  if (input.pattern && input.bar === undefined && input.fromBar === undefined) {
    if (input.kind === 'crash') throw new ArrangeInputError('a crash goes on the playlist: give a bar');
    const len = lengthOfPattern(p, input.pattern);
    const step: VariantStep = whole
      ? { kind: kindOf[input.kind], from: 0, to: len, energy: 4, ...extra }
      : { kind: kindOf[input.kind], from: len - beats * BEAT, to: len, energy: 4 };
    const { root, steps } = rootOf(p, input.pattern);
    const variant = deriveVariant(d, root, [...steps, step], env.variant);
    const name = p.patterns[variant]?.name ?? '?';
    return {
      variant,
      changes: [variant === input.pattern || variant === root ? `“${name}” has nothing to change for that` : `Made “${name}”`],
      warnings: [],
      touched: null,
      clipIds: [],
      findings: [],
    };
  }
  const at = (b: number) => Math.max(0, Math.round(b)) * bar;
  let from: Tick;
  let to: Tick;
  if (input.fromBar !== undefined) {
    from = at(input.fromBar - 1);
    to = at(input.toBar ?? input.fromBar);
  } else if (input.bar !== undefined) {
    from = at(input.bar - 1);
    to = at(input.bar);
  } else throw new ArrangeInputError('where? give a bar, from_bar and to_bar, or a pattern');
  if (to <= from) throw new ArrangeInputError('to_bar comes before from_bar');
  if (input.kind === 'crash') {
    guard?.(from, from + BEAT, 'vary');
    const clips = placeCrashes(d, [{ at: from, velocity: 0.9, lane: laneAllocatorFor(p).place(CRASH_LANE, from, from + 4 * bar) }], env);
    return { changes: [`Added a crash at bar ${from / bar + 1}`], warnings: [], touched: { from, to: from + bar }, clipIds: clips, findings: [] };
  }
  const span = whole ? { from, to } : { from: to - Math.min(beats * BEAT, to - from), to };
  guard?.(span.from, span.to, 'vary');
  const changed = applyEditsInPlace(d, [{ kind: kindOf[input.kind], ...span, energy: 4, why: 'end', ...extra }], env, input.lane ? { lanes: new Set([input.lane]) } : {});
  const label = input.kind.replace(/_/g, ' ').replace('808 slide', '808 slide');
  return {
    changes: changed.length
      ? [`Added ${whole ? `${label} over ${lineOf(p, from, to)}` : `a ${label} at the end of bar ${to / bar}`} (${count(changed.length, 'clip')} now play${changed.length === 1 ? 's' : ''} a variant)`]
      : [`Nothing at ${lineOf(p, span.from, span.to)} could take a ${label} (it needs drums, hats or an 808 playing there)`],
    warnings: [],
    touched: changed.length ? span : null,
    clipIds: changed,
    findings: [],
  };
}

/** Rebuilds the variants whose source changed by hand; returns a line for a toast. */
export function refreshInDraft(d: Draft<Project>, s: Services, base: Project): RunResult {
  const p = d as unknown as Project;
  const { env } = applyEnvFor(d, s, base, inferStyle(p), { create: false });
  const r = refreshVariants(d, env.variant);
  const kept = r.handEdited.length ? ` (${count(r.handEdited.length, 'variant')} you edited by hand stay as they are)` : '';
  return {
    changes: [r.rebuilt.length ? `Rebuilt ${count(r.rebuilt.length, 'variation')} from their source patterns${kept}` : `The variations are up to date${kept}`],
    warnings: [],
    touched: null,
    clipIds: [],
    findings: [],
  };
}
