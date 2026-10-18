/**
 * The master's loudness stage: the Limiter's input and, when the Limiter alone can't reach the loudness cleanly, the
 * Maximizer (a limiter plus a gentle soft clip on the peaks, placed before the Limiter). `tuneLoudness` finds the
 * inputs by listening; `applyLoudness` writes them into the project.
 */
import type { Draft } from 'immer';
import { MASTER, type Project, type SlotId } from '@core/model/types';
import { addFxSlot } from '@core/ops/mixer';
import type { Services } from '../../services';
import { MAXIMIZER } from '../recipe-parts';
import { MAXIMIZER_RECIPE } from '../recipes';
import { instanceFor } from '../setup';
import { clamp, LIMITER_INPUT_MAX_DB } from './level-math';

/** The most input the Maximizer gets (it asks for a warning past `MAXIMIZER_HARD_DB`). */
export const MAXIMIZER_INPUT_MAX_DB = 18;
/** Past this much Maximizer input (dB) the musician is warned the mix may sound dense. */
export const MAXIMIZER_HARD_DB = 14;
/** The Maximizer's soft clip depth (dB) as auto-level sets it: measured as the cleanest at equal loudness (architecture.md). */
export const MAXIMIZER_CLIP_DB = 2;
/** The master lands within this many dB of its target. */
export const LOUDNESS_TOLERANCE = 0.5;
/** Renders spent correcting the Limiter's input (each costs one render). */
const LIMITER_PASSES = 3;
/** ... and the Maximizer's. */
const MAXIMIZER_PASSES = 4;
/** An input change smaller than this (dB) is not worth another render. */
const MIN_INPUT_STEP_DB = 0.05;
/** The master's hard clipper at most this much drive once tamed (dB). */
const TAME_DRIVE_DB = 3;
/** The loudness a dB of Limiter input buys when it works hard, at best (dB per dB): used to see a target is out of reach. */
const LIMITER_BEST_GAIN_PER_DB = 0.5;
/** How far (dB) short of the target counts as out of the Limiter's reach. */
const OUT_OF_REACH_DB = 1;
/** The first guess for the loudness a dB of Maximizer input buys (dB per dB). */
const MAXIMIZER_GUESS_GAIN_PER_DB = 0.8;
/** The Maximizer reaches the same loudness with about this much less input (dB) than the Limiter would need. */
const MAXIMIZER_INPUT_SAVING_DB = 1;
/** The Maximizer's first guess stays between these inputs (dB). */
const MAXIMIZER_GUESS_MIN_DB = 4;
const MAXIMIZER_GUESS_MAX_DB = 16;
/** The slope (dB of loudness per dB of input) estimated from two readings stays between these. */
const SLOPE_MIN = 0.15;
const SLOPE_MAX = 1.2;
/** The slope assumed before there are two readings: cautious when the master is too quiet, 1 when too loud. */
const FIRST_SLOPE_WHEN_QUIET = 0.6;

/** What the master's loudness stage is set to: the Limiter's input, and the Maximizer's (null: not used, bypassed if there is one). */
export interface LoudnessState {
  limiter: number;
  maximizer: number | null;
}

/**
 * A hard clipper on the master flattens every loud hit of the whole mix, which sounds like static
 * and breaking up: leveling turns it into gentle tape saturation. Returns what it changed.
 */
export function tameMasterClipper(draft: Draft<Project>): string[] {
  const changes: string[] = [];
  for (const slot of draft.mixer.inserts[MASTER]?.fx ?? []) {
    if (slot.plugin.pluginId !== 'agstudio.saturator' || !slot.enabled) continue;
    const params = slot.plugin.params;
    if (params.mode !== 'clip') continue;
    params.mode = 'tape';
    if (typeof params.drive === 'number' && params.drive > TAME_DRIVE_DB) params.drive = TAME_DRIVE_DB;
    const drive = typeof params.drive === 'number' ? params.drive : TAME_DRIVE_DB;
    changes.push(`Master Saturator: hard clip → tape at ${drive} dB drive (clipping the whole mix sounds like static)`);
  }
  return changes;
}

/** An input tried and the loudness it gave. */
interface Reading {
  input: number;
  lufs: number;
}

/**
 * The next input (the Limiter's or the Maximizer's) for an asked-for loudness: a limiter gives back less than it is given once
 * it works hard, so the step is the error divided by the slope the last two readings showed (a cautious guess before there are two).
 */
function nextInput(tried: readonly Reading[], target: number, max: number): number {
  const last = tried[tried.length - 1]!;
  let slope = target > last.lufs ? FIRST_SLOPE_WHEN_QUIET : 1;
  const previous = tried[tried.length - 2];
  if (previous && Math.abs(last.input - previous.input) > MIN_INPUT_STEP_DB) {
    slope = clamp((last.lufs - previous.lufs) / (last.input - previous.input), SLOPE_MIN, SLOPE_MAX);
  }
  return clamp(last.input + (target - last.lufs) / slope, 0, max);
}

/** What `tuneLoudness` works with and what it ends up with. */
interface Tuning<Measured extends { lufs: number }> {
  target: number;
  state: LoudnessState;
  /** The latest measurement of the master (with `state` applied). */
  master: Measured;
  hasLimiter: boolean;
  hasMaximizer: boolean;
  /** Applies a state to the project (one edit). */
  step(state: LoudnessState): Promise<void>;
  /** Plays the mix through the master and measures it. */
  render(): Promise<Measured>;
}

const isOnTarget = (tuning: Tuning<{ lufs: number }>) =>
  !Number.isFinite(tuning.master.lufs) || Math.abs(tuning.master.lufs - tuning.target) <= LOUDNESS_TOLERANCE;

/** Sets a new state, applies it and measures the result. */
async function tryState<Measured extends { lufs: number }>(tuning: Tuning<Measured>, state: LoudnessState) {
  tuning.state = state;
  await tuning.step(state);
  tuning.master = await tuning.render();
}

/** Corrects the Limiter's input by secant steps until the master is on target (or the Limiter is out of reach). */
async function tuneLimiter<Measured extends { lufs: number }>(tuning: Tuning<Measured>): Promise<void> {
  const tried: Reading[] = [];
  // Clearly out of the Limiter's reach: a dB of input beyond what it has now buys about half a dB at best.
  const isOutOfReach = () =>
    tuning.master.lufs + LIMITER_BEST_GAIN_PER_DB * (LIMITER_INPUT_MAX_DB - tuning.state.limiter) <
    tuning.target - OUT_OF_REACH_DB;
  for (let pass = 0; pass < LIMITER_PASSES && tuning.hasLimiter && !isOnTarget(tuning); pass++) {
    const isTooQuiet = tuning.master.lufs < tuning.target;
    const isAtItsMax = tuning.state.limiter >= LIMITER_INPUT_MAX_DB - MIN_INPUT_STEP_DB;
    if (isTooQuiet && (isAtItsMax || (tuning.hasMaximizer && isOutOfReach()))) break;
    tried.push({ input: tuning.state.limiter, lufs: tuning.master.lufs });
    const next = nextInput(tried, tuning.target, LIMITER_INPUT_MAX_DB);
    if (Math.abs(next - tuning.state.limiter) <= MIN_INPUT_STEP_DB) break;
    await tryState(tuning, { limiter: next, maximizer: null });
  }
}

/** The same push through the Maximizer (a limiter and a soft clip), with the Limiter back at 0 dB. */
async function tuneMaximizer<Measured extends { lufs: number }>(tuning: Tuning<Measured>): Promise<void> {
  const tried: Reading[] = [];
  const guess = clamp(
    tuning.state.limiter +
      (tuning.target - tuning.master.lufs) / MAXIMIZER_GUESS_GAIN_PER_DB -
      MAXIMIZER_INPUT_SAVING_DB,
    MAXIMIZER_GUESS_MIN_DB,
    MAXIMIZER_GUESS_MAX_DB,
  );
  await tryState(tuning, { limiter: 0, maximizer: guess });
  for (let pass = 0; pass < MAXIMIZER_PASSES && !isOnTarget(tuning); pass++) {
    const current = tuning.state.maximizer!;
    tried.push({ input: current, lufs: tuning.master.lufs });
    const next = nextInput(tried, tuning.target, MAXIMIZER_INPUT_MAX_DB);
    if (Math.abs(next - current) <= MIN_INPUT_STEP_DB) break;
    await tryState(tuning, { limiter: 0, maximizer: next });
  }
}

/**
 * Brings the master to `target` by listening: the Limiter's input first (up to what it gives cleanly), then, when that falls short, the
 * Maximizer (the Limiter back at 0 dB), each corrected by a secant estimate from its own readings. `step` applies a state to the project
 * (one edit), `render` plays the mix through the master and measures it. Starts from `master`, measured with `state` applied.
 */
export async function tuneLoudness<Measured extends { lufs: number }>(
  options: Tuning<Measured>,
): Promise<{ state: LoudnessState; master: Measured }> {
  const tuning = { ...options };
  await tuneLimiter(tuning);
  const stillTooQuiet = Number.isFinite(tuning.master.lufs) && tuning.master.lufs < tuning.target - LOUDNESS_TOLERANCE;
  if (tuning.hasLimiter && tuning.hasMaximizer && stillTooQuiet) await tuneMaximizer(tuning);
  return { state: tuning.state, master: tuning.master };
}

/** Rounds a gain setting to the hundredths the plugin panel shows. */
const toHundredths = (value: number) => Math.round(value * 100) / 100;

/**
 * Applies a `LoudnessState` in a draft: the Limiter's input, and the Maximizer's (added just before the Limiter when it is
 * needed and not there yet; bypassed when it is not needed). Returns what it added.
 */
export function applyLoudness(
  draft: Draft<Project>,
  services: Services,
  limiterSlotId: SlotId | undefined,
  state: LoudnessState,
): string[] {
  const added: string[] = [];
  const masterFx = draft.mixer.inserts[MASTER]?.fx;
  if (!masterFx) return added;
  const limiter = limiterSlotId ? masterFx.find((slot) => slot.id === limiterSlotId) : undefined;
  if (limiter) limiter.plugin.params.input = toHundredths(state.limiter);
  const existingMaximizer = [...masterFx].reverse().find((slot) => slot.plugin.pluginId === MAXIMIZER);
  if (state.maximizer === null) {
    if (existingMaximizer?.enabled) existingMaximizer.enabled = false;
    return added;
  }
  let maximizer = existingMaximizer;
  if (!maximizer) {
    const instance = instanceFor(services, MAXIMIZER_RECIPE);
    const insertAt = limiter ? masterFx.indexOf(limiter) : undefined;
    const slotId = instance ? addFxSlot(draft, MASTER, instance, insertAt) : null;
    maximizer = slotId ? masterFx.find((slot) => slot.id === slotId) : undefined;
    if (maximizer) added.push(MAXIMIZER_RECIPE.label);
  }
  if (!maximizer) return added;
  maximizer.enabled = true;
  maximizer.plugin.params.input = toHundredths(state.maximizer);
  maximizer.plugin.params.clip = MAXIMIZER_CLIP_DB;
  if (limiter && typeof limiter.plugin.params.ceiling === 'number')
    maximizer.plugin.params.ceiling = limiter.plugin.params.ceiling;
  return added;
}

/** A dB value with a real minus sign and one decimal ("−3.0", "+1.5"). */
export const signedDb = (value: number) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(1)}`;

/** The lines the loudness stage adds to the change list. */
export function loudnessChanges(state: LoudnessState, hasLimiter: boolean, added: readonly string[]): string[] {
  const lines: string[] = [];
  if (state.maximizer !== null) {
    if (added.length) lines.push(`Master: ${added.join(', ')} before the Limiter`);
    lines.push(
      `Maximizer input ${signedDb(state.maximizer)} dB (${MAXIMIZER_CLIP_DB} dB soft clip on the peaks; the Limiter stays at 0 dB)`,
    );
  } else if (hasLimiter) {
    lines.push(`Limiter input ${signedDb(state.limiter)} dB`);
  }
  return lines;
}

/** What to tell the musician when the master is not where it was asked to be. */
export function warnLoudness(
  warnings: string[],
  lufs: number,
  target: number,
  state: LoudnessState,
  hasLimiter: boolean,
): void {
  if (!Number.isFinite(lufs)) return;
  if (hasLimiter && lufs < target - LOUDNESS_TOLERANCE) {
    const limitReached = state.maximizer !== null ? 'the Maximizer is at its limit' : 'the Limiter has no more to give';
    warnings.push(
      `level mix: the master reaches ${lufs.toFixed(1)} LUFS, ${(target - lufs).toFixed(1)} dB under the target of ${target.toFixed(1)}: ${limitReached} on this mix (its peaks are too high for that loudness); shortening the drums’ tails or a little saturation on the drum bus gets closer`,
    );
  } else if (state.maximizer !== null && state.maximizer > MAXIMIZER_HARD_DB) {
    warnings.push(
      `level mix: the Maximizer is pushed ${state.maximizer.toFixed(1)} dB to reach that loudness; the mix may sound dense, and a lower target keeps more punch`,
    );
  }
}
