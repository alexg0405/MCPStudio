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
import { existingFx, fillLikeClips, inferSections, layeredFills, loopingPatterns } from '@core/arrange/infer';
import { lengthOfPattern } from '@core/arrange/notes';
import { FILL_ROTATION } from '@core/arrange/phrases';
import { CRASH_LANE, loopStartCrashes, planArrangement, planDevelop, type ArrangementPlan } from '@core/arrange/plan';
import type { SectionSpec } from '@core/arrange/sections';
import type { EndingKind, FxLevel } from '@core/arrange/transitions';
import { inferStyle, type Style } from '@core/beat/style';
import type { ChannelId, ClipId, InsertId, LaneId, PatternId, Project, Tick, VariantKind, VariantStep } from '@core/model/types';
import { tidySong } from '@core/ops/tidy';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import { setupMix } from '../mix/setup';
import type { Services } from '../services';
import { checkArrangement, type Finding } from './check';
import { applyEnvFor, rolesOf } from './env';
import { plain } from './plain';
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
  /** Source patterns the arranger must not edit (they also play where the arrangement doesn't reach). */
  protect?: ReadonlySet<PatternId>;
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
  const report = applyArrangement(d, plan, env, { replace: input.replace, replaceTo, ...(input.protect ? { protect: input.protect } : {}) });
  const findings = checkArrangement(s, plain(d), { style, sections: plan.sections });
  const extra: string[] = [];
  for (const m of report.movedCrashes)
    extra.push(`Moved the crash at the start of “${p.patterns[m.patternId]?.name ?? 'a beat'}” into crash hits (it crashed on every loop)`);
  return {
    plan,
    style,
    changes: [arrangeSummary(plan), ...made, ...changes, ...extra],
    // What the arranger made; problems the song already had elsewhere aren't this answer's.
    warnings: findings
      .filter((f) => f.severity === 'bug' && f.to > plan.from && f.from < plan.to)
      .map((f) => `arrangement check: ${f.message}`),
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
    const q = plain(d);
    const looping = loopingPatterns(q);
    const inRange = new Set<PatternId>();
    const outside = new Set<PatternId>();
    for (const c of Object.values(q.playlist.clips)) {
      if (c.kind !== 'pattern') continue;
      const root = rootOf(q, c.patternId).root;
      (c.start >= from && c.start + c.length <= to ? inRange : outside).add(root);
    }
    const moves = [...inRange]
      .filter((pid) => !outside.has(pid) && looping.has(pid) && !q.patterns[pid]?.derived && lengthOfPattern(q, pid) <= 4 * bar)
      .flatMap((pid) => loopStartCrashes(q, pid, env.variant).map((m) => ({ patternId: pid, ...m })));
    const moved = moveLoopCrashes(d, { loopCrashes: moves });
    if (moved.length) {
      refreshVariants(d, env.variant, new Set(moved.map((m) => m.patternId)));
      changes.push(
        `Moved the crash on the first beat of ${moved.map((m) => `“${q.patterns[m.patternId]?.name ?? '?'}”`).join(', ')} out (it crashed on every loop; crashes now mark the sections)`,
      );
    }
    // Fills on their own track replace the drums under them instead of piling on.
    const r2 = plain(d);
    const layered = layeredFills(r2, env.variant).filter((l) => l.fill.from < to && l.fill.to > from);
    const fillClips = new Set(fillLikeClips(r2, env.variant).map((f) => f.clipId));
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
  const now = plain(d);
  const sections = inferSections(now, env.variant);
  const fillClips = fillLikeClips(now, env.variant);
  const fills = fillClips.map((f) => ({ from: f.from, to: f.to }));
  const plan = planDevelop(
    now,
    sections,
    { style, fills: input.fills, transitions: input.transitions, fx: input.fx ? 'auto' : 'none', from, to },
    { fx: existingFx(now, env.variant), fills },
    laneAllocatorFor(now),
  );
  // Elements reaching far outside the range are left out (a part of the song stays a part).
  const near = (a: Tick, b: Tick) => a >= from - bar && b <= to + bar;
  // Fills playing from their own clips are the musician's: nothing changes them.
  const changed = applyEditsInPlace(d, plan.events, env, { protect: new Set(fillClips.map((f) => f.clipId)) });
  const fx = placeFx(d, plan.fx.filter((f) => near(f.start, f.start + Math.min(f.length, bar))), env);
  const crashes = placeCrashes(d, plan.crashes.filter((c) => near(c.at, c.at)), env);
  const automation = placeAutomation(d, plan.automation.filter((a) => near(a.start, a.start + a.length)), env, { skipBusy: true });
  const findings = checkArrangement(s, plain(d), { style });
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

export { TRANSITION_KINDS, transitionInDraft, type TransitionInput, type TransitionKind } from './transition';

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
