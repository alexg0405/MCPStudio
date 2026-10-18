/**
 * Leveling the mix by ear, the way a mixer starts: render the role buses of the song's busiest
 * part (each as it reaches the master, the master's chain bypassed), measure their loudness, set
 * every bus to its style's level relative to the kick, trim them together to −16 LUFS before the
 * Limiter, and set the Limiter's input so the master lands on the style's loudness. One render of
 * the whole mix checks it and corrects the input while it is more than half a dB off. A loudness the Limiter
 * cannot give cleanly (it would need more than +10 dB of input) is shared with the Maximizer (a limiter
 * plus a gentle soft clip on the peaks, before the Limiter: `tuneLoudness`). The math is pure
 * (`levelMoves`, `limiterInput`); `autoLevel` does the rendering.
 *
 * The pieces live in `leveling/`: the style targets, the level math, the loudness stage, the listening window,
 * the offline renderer and the project edits. This file is the flow that puts them together.
 */
import { STYLE_LABELS } from '@core/beat/style';
import { tempoMapOf } from '@core/automation/tempo';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { MASTER, type InsertId, type Project } from '@core/model/types';
import { planStems, stemProject, withoutMasterChain, type StemPlan } from '@core/query/stems';
import { ticksPerBar } from '@core/time/ppq';
import type { Measurement } from '../analysis/measure';
import type { Services } from '../services';
import { BUS_NAMES, findMixLayout, type MixLayout } from './layout';
import { MAXIMIZER } from './recipe-parts';
import { busiestWindow, type LevelWindow } from './leveling/listening-window';
import { createLoudnessEditor, type FaderEdit } from './leveling/loudness-edit';
import {
  dbToGain,
  gainToDb,
  clamp,
  levelMoves,
  limiterInput,
  PRE_LIMITER_LUFS,
  type BusLevel,
} from './leveling/level-math';
import { loudnessChanges, signedDb, tuneLoudness, warnLoudness, type LoudnessState } from './leveling/loudness-stage';
import { createMixRenderer, type MixRenderer } from './leveling/mix-renderer';
import { LEVEL_TARGETS, LEVELED, type LeveledBus } from './leveling/targets';
import type { AutoLevelOptions, AutoLevelResult, BusReading } from './leveling/types';

export { busiestWindow, type LevelWindow } from './leveling/listening-window';
export {
  LIMITER_INPUT_MAX_DB,
  levelMoves,
  limiterInput,
  limiterMax,
  MOVE_MAX_DB,
  MOVE_MIN_DB,
  PRE_LIMITER_LUFS,
  type BusLevel,
  type LevelMove,
  type LevelPlan,
} from './leveling/level-math';
export {
  applyLoudness,
  LOUDNESS_TOLERANCE,
  MAXIMIZER_CLIP_DB,
  MAXIMIZER_INPUT_MAX_DB,
  tameMasterClipper,
  type LoudnessState,
} from './leveling/loudness-stage';
export { LEVEL_TARGETS, LEVELED, type LeveledBus, type LevelTarget } from './leveling/targets';
export type { AutoLevelOptions, AutoLevelResult, BusReading } from './leveling/types';

/** The sample rate leveling renders at. */
const DEFAULT_RENDER_RATE_HZ = 48000;
/** A bus fader change smaller than this (dB) is not worth a line in the change list. */
const MIN_REPORTED_MOVE_DB = 0.05;
/** How far (dB) the trim of a mix without role buses may go: down this much, up this much. */
const LOUDNESS_ONLY_TRIM_MIN_DB = -24;
const LOUDNESS_ONLY_TRIM_MAX_DB = 6;
/** Role leveling needs the buses to carry at least this share of the channels that play. */
const MIN_BUS_SHARE_OF_CHANNELS = 2 / 3;
/** A master still this far (dB) over its target with the Limiter's input at 0 dB is being pushed by something before it. */
const TOO_LOUD_BEFORE_LIMITER_DB = 2;

/** What the leveling will render, decided from the song before anything is rendered. */
interface RenderPlan {
  part: LevelWindow;
  layout: MixLayout;
  /** The project with the master chain bypassed (what the bus stems are cut from). */
  bypassed: Project;
  /** Every stem of the part (each mutes the others); only the bus stems are rendered. */
  allStems: StemPlan[];
  busStems: StemPlan[];
  /** The buses by role that exist in the mix. */
  busIds: [LeveledBus, InsertId][];
  /** A mix without role buses: only its loudness is set, its balance stays. */
  isLoudnessOnly: boolean;
  seconds: number;
  /** Renders the leveling will make (progress runs over them). */
  steps: number;
}

const channelCount = (stems: readonly { channels: readonly unknown[] }[]) =>
  stems.reduce((count, stem) => count + stem.channels.length, 0);

/** Works out which part to listen to and what to render. Null when there is nothing to level. */
function planRender(services: Services, options: AutoLevelOptions, project: Project): RenderPlan | null {
  const layout = findMixLayout(project);
  const busIds = LEVELED.map((role) => [role, layout.buses[role]] as const).filter(
    (entry): entry is [LeveledBus, InsertId] => !!entry[1],
  );
  const part = busiestWindow(project, services.view.getState().currentPatternId, options.fromTick, options.bars);
  if (!part) return null;
  const toTick = part.fromTick + part.bars * ticksPerBar(project.transport.timeSig);
  const tempo = tempoMapOf(project, part.mode);
  const seconds = tempo.tickToSeconds(toTick) - tempo.tickToSeconds(part.fromTick);
  const bypassed = withoutMasterChain(project);
  const allStems = planStems(bypassed, { mode: part.mode, patternId: part.patternId, fromTick: part.fromTick, toTick });
  const busStems = allStems.filter((stem) => busIds.some(([, id]) => id === stem.insertId));
  // A mix without role buses (built by hand, imported; a track named "Kick" doesn't make one): only
  // its loudness is set, its balance stays. Role leveling needs the buses to carry most of what plays.
  const isLoudnessOnly =
    !busStems.length || channelCount(busStems) < MIN_BUS_SHARE_OF_CHANNELS * channelCount(allStems);
  if (isLoudnessOnly && !allStems.length) return null;
  const steps = isLoudnessOnly ? 3 : busStems.length + 2;
  return { part, layout, bypassed, allStems, busStems, busIds, isLoudnessOnly, seconds, steps };
}

/** What the master's loudness stage starts from: the Limiter's input to reach the target from `preLimiterLufs`. */
function startingLoudnessState(
  style: AutoLevelOptions['style'],
  hasLimiter: boolean,
  preLimiterLufs: number,
  targetLufs: number | undefined,
): LoudnessState {
  return { limiter: hasLimiter ? limiterInput(style, preLimiterLufs, targetLufs) : 0, maximizer: null };
}

/**
 * Listens to the whole mix and corrects the Limiter (and, when it falls short, the Maximizer) while the master is off its target.
 * `editor` writes each state into the project.
 */
async function tuneMasterByEar(
  services: Services,
  renderer: MixRenderer,
  target: number,
  state: LoudnessState,
  hasLimiter: boolean,
  apply: (state: LoudnessState) => Promise<void>,
): Promise<{ state: LoudnessState; master: Measurement }> {
  const measureMaster = () =>
    renderer.measure(services.doc.getState().project, { label: 'The mix', safetyLimiter: true, truePeak: true });
  return tuneLoudness({
    target,
    state,
    master: await measureMaster(),
    hasLimiter,
    hasMaximizer: !!services.plugins.get(MAXIMIZER),
    step: apply,
    render: measureMaster,
  });
}

/** The pieces of a result's message about the master: how loud it plays, and the target (with the true peak). */
function masterSummary(master: Measurement, target: number): { playsAt: string; targetNote: string } {
  const truePeak =
    master.truePeakDb !== null && Number.isFinite(master.truePeakDb)
      ? `, true peak ${signedDb(master.truePeakDb)} dBTP`
      : '';
  return {
    playsAt: Number.isFinite(master.lufs) ? `${signedDb(master.lufs)} LUFS` : 'silence',
    targetNote: `the target is ${signedDb(target)}${truePeak}`,
  };
}

/**
 * Levels the project's role mix (see the file comment) as one edit: amended into `entry` when
 * given. Resolves null when there is nothing to level; rejects with an AbortError when stopped.
 */
export async function autoLevel(services: Services, options: AutoLevelOptions): Promise<AutoLevelResult | null> {
  const project = services.doc.getState().project;
  const plan = planRender(services, options, project);
  if (!plan) return null;
  const sampleRate = options.sampleRate ?? DEFAULT_RENDER_RATE_HZ;
  const renderer = createMixRenderer(services, options, plan.part, sampleRate, plan.seconds, plan.steps);
  if (!options.whenQuiet) services.engine.stop();
  const warnings: string[] = [];
  if (plan.isLoudnessOnly) return levelLoudnessOnly(services, options, plan, renderer, warnings);
  return levelRoleBuses(services, options, project, plan, renderer, warnings);
}

/** Measures each role bus on its own (the master chain bypassed). */
async function measureBuses(
  options: AutoLevelOptions,
  project: Project,
  plan: RenderPlan,
  renderer: MixRenderer,
): Promise<BusLevel[]> {
  const levels: BusLevel[] = [];
  for (const stem of plan.busStems) {
    const role = plan.busIds.find(([, id]) => id === stem.insertId)![0];
    const insert = project.mixer.inserts[stem.insertId]!;
    const measurement = await renderer.measure(stemProject(plan.bypassed, plan.allStems, stem), {
      label: insert.name ?? BUS_NAMES[role],
      safetyLimiter: false,
      truePeak: false,
    });
    levels.push({
      role,
      lufs: measurement.silent ? -Infinity : measurement.lufs,
      gain: insert.volume,
      pinned: options.pinned?.has(stem.insertId) ?? false,
    });
  }
  return levels;
}

/** The change lines for the buses whose fader moved, with the readings for the result. */
function describeBusMoves(
  project: Project,
  layout: MixLayout,
  moves: ReturnType<typeof levelMoves>['moves'],
  levels: readonly BusLevel[],
): { buses: BusReading[]; changes: string[] } {
  const buses: BusReading[] = moves.map((move) => ({
    role: move.role,
    before: levels.find((level) => level.role === move.role)!.lufs,
    after: move.lufs,
    target: move.target,
    fromDb: gainToDb(move.from),
    toDb: gainToDb(move.to),
  }));
  const changes = buses
    .filter((bus) => Math.abs(bus.toDb - bus.fromDb) >= MIN_REPORTED_MOVE_DB)
    .map((bus) => {
      const name = project.mixer.inserts[layout.buses[bus.role]!]?.name ?? BUS_NAMES[bus.role];
      return `${name} fader ${signedDb(bus.fromDb)} → ${signedDb(bus.toDb)} dB`;
    });
  return { buses, changes };
}

/** Role leveling: each bus to its style level around the kick, the buses trimmed together, then the master's loudness. */
async function levelRoleBuses(
  services: Services,
  options: AutoLevelOptions,
  project: Project,
  plan: RenderPlan,
  renderer: MixRenderer,
  warnings: string[],
): Promise<AutoLevelResult | null> {
  const { style } = options;
  const { layout } = plan;
  const levels = await measureBuses(options, project, plan, renderer);
  const levelPlan = levelMoves(levels, style);
  if (!levelPlan.moves.length) return null;

  // One edit: the faders and the Limiter's input.
  const masterFx = project.mixer.inserts[MASTER]?.fx ?? [];
  const limiter = layout.limiter ? masterFx.find((slot) => slot.id === layout.limiter) : undefined;
  if (!limiter)
    warnings.push('level mix: the master has no Limiter, so its loudness stays as it is (set up the mix first)');
  const moveFaders: FaderEdit = () => (draft) => {
    for (const move of levelPlan.moves) {
      const id = layout.buses[move.role];
      if (id && draft.mixer.inserts[id] && !options.pinned?.has(id)) draft.mixer.inserts[id]!.volume = move.to;
    }
  };
  const editor = createLoudnessEditor(services, options, project.projectId, limiter?.id, moveFaders);
  // From where the buses sum (−16 LUFS unless the faders ran out of room) to the style's loudness.
  const startState = startingLoudnessState(
    style,
    !!limiter,
    Math.min(PRE_LIMITER_LUFS, levelPlan.sumLufs),
    options.targetLufs,
  );
  await editor.apply(startState);

  const target = options.targetLufs ?? LEVEL_TARGETS[style].master;
  const tuned = await tuneMasterByEar(services, renderer, target, startState, !!limiter, editor.apply);
  warnLoudness(warnings, tuned.master.lufs, target, tuned.state, !!limiter);
  options.progress?.('Done', 1);

  const { buses, changes } = describeBusMoves(project, layout, levelPlan.moves, levels);
  changes.push(...loudnessChanges(tuned.state, !!limiter, editor.addedPlugins), ...editor.tamedClipper);
  const summary = masterSummary(tuned.master, target);
  const forWhom = options.targetLufs !== undefined ? 'the reference’s loudness' : STYLE_LABELS[style].toLowerCase();
  const message = `Leveled the mix for ${forWhom}: each bus sits at its level around the kick, and the master plays at ${summary.playsAt} (${summary.targetNote}).`;
  return {
    message,
    changes,
    warnings,
    style,
    buses,
    master: { lufs: tuned.master.lufs, truePeakDb: tuned.master.truePeakDb, target },
    limiterInput: limiter ? tuned.state.limiter : null,
    maximizerInput: tuned.state.maximizer,
  };
}

/**
 * Leveling a mix without role buses: everything that reaches the master moves together (the routes
 * into the master and the channels that play straight into it) so the mix sums to −16 LUFS before
 * the master chain, then the Limiter's input sets the style's loudness. The balance between tracks
 * stays as the musician made it. Without a Limiter only the trim happens.
 */
async function levelLoudnessOnly(
  services: Services,
  options: AutoLevelOptions,
  plan: RenderPlan,
  renderer: MixRenderer,
  warnings: string[],
): Promise<AutoLevelResult | null> {
  const { style } = options;
  const before = await renderer.measure(plan.bypassed, {
    label: 'The mix before the master',
    safetyLimiter: false,
    truePeak: false,
  });
  if (before.silent || !Number.isFinite(before.lufs)) return null;
  const trimDb = clamp(PRE_LIMITER_LUFS - before.lufs, LOUDNESS_ONLY_TRIM_MIN_DB, LOUDNESS_ONLY_TRIM_MAX_DB);
  const limiterSlotId = findMixLayout(services.doc.getState().project).limiter;
  if (!limiterSlotId)
    warnings.push('level mix: the master has no Limiter, so the mix was only trimmed (set up the mix for a Limiter)');

  // The trim goes in with the first edit only.
  let pendingTrimDb = trimDb;
  const trimEverythingIntoMaster: FaderEdit = () => {
    const gain = dbToGain(pendingTrimDb);
    pendingTrimDb = 0;
    return (draft) => {
      for (const insert of Object.values(draft.mixer.inserts)) {
        for (const route of insert.routes) {
          if (route.to === MASTER) route.level = Math.min(MAX_INSERT_VOLUME, route.level * gain);
        }
      }
      for (const channel of Object.values(draft.channels)) {
        if (channel.kind !== 'automation' && channel.output === MASTER) {
          channel.volume = Math.min(MAX_INSERT_VOLUME, channel.volume * gain);
        }
      }
    };
  };
  const editor = createLoudnessEditor(
    services,
    options,
    plan.bypassed.projectId,
    limiterSlotId,
    trimEverythingIntoMaster,
  );
  const startState = startingLoudnessState(style, !!limiterSlotId, PRE_LIMITER_LUFS, options.targetLufs);
  await editor.apply(startState);

  const target = options.targetLufs ?? LEVEL_TARGETS[style].master;
  const tuned = await tuneMasterByEar(services, renderer, target, startState, !!limiterSlotId, editor.apply);
  // Still too loud with the Limiter's input at 0 dB: something before it (a clipper, a hot saturator) pushes it.
  if (Number.isFinite(tuned.master.lufs) && tuned.master.lufs > target + TOO_LOUD_BEFORE_LIMITER_DB) {
    warnings.push(
      `level mix: the master still plays at ${tuned.master.lufs.toFixed(1)} LUFS: an effect on the master before the Limiter (a clipper or saturator with a lot of drive) is pushing it; lower its drive`,
    );
  }
  warnLoudness(warnings, tuned.master.lufs, target, tuned.state, !!limiterSlotId);
  options.progress?.('Done', 1);

  const changes = [`Everything into the master ${signedDb(trimDb)} dB (the balance between tracks stays)`];
  changes.push(...loudnessChanges(tuned.state, !!limiterSlotId, editor.addedPlugins), ...editor.tamedClipper);
  const summary = masterSummary(tuned.master, target);
  const forWhom = options.targetLufs !== undefined ? 'the reference' : STYLE_LABELS[style].toLowerCase();
  const message = `Set the loudness for ${forWhom}: the mix was ${signedDb(before.lufs)} LUFS going into the master, and now plays at ${summary.playsAt} (${summary.targetNote}). Your balance between tracks is unchanged.`;
  return {
    message,
    changes,
    warnings,
    style,
    buses: [],
    master: { lufs: tuned.master.lufs, truePeakDb: tuned.master.truePeakDb, target },
    limiterInput: limiterSlotId ? tuned.state.limiter : null,
    maximizerInput: tuned.state.maximizer,
  };
}
