import type { Draft } from 'immer';
import type { ChannelId, ClipId, LaneId, PatternClip, PatternId, Project, Tick } from '../../model/types';
import { newId } from '../../model/ids';
import { addMarker, removeMarker } from '../../ops/markers';
import { addClips, clearRange } from '../../ops/playlist';
import type { ArrangementPlan } from '../plan';
import { placeAutomation } from './automation';
import { arrangerThings, collectGarbage, moveLoopCrashes } from './cleanup';
import { laneNamed } from './lanes';
import { placeCrashes, placeFx } from './sounds';
import type { ApplyEnv, ApplyReport } from './types';
import { deriveVariant } from './variants';

/** What the arranger made in a range, to be removed afterwards if nothing plays it any more. */
type ArrangerThings = ReturnType<typeof arrangerThings>;

/** How to write a plan: clear its range first, and which patterns keep their loop-start crashes. */
export interface ApplyOptions {
  replace: boolean;
  /** Clear up to here instead of the plan's end (replacing a longer song with a shorter one). */
  replaceTo?: Tick;
  /** Patterns that also play outside the part being worked on keep their crashes. */
  protect?: ReadonlySet<PatternId>;
}

/**
 * Clears what the plan will replace: the arranger's own sounds and curves that start in the range
 * (whole, their tails ring past its end), every clip in it (trimmed at the edges) and its markers.
 * Returns how many clips went and what the arranger had made there.
 */
function clearForPlan(
  d: Draft<Project>,
  plan: ArrangementPlan,
  env: ApplyEnv,
  replaceTo: Tick | undefined,
): { replaced: number; old: ArrangerThings } {
  const p = d as unknown as Project;
  const to = Math.max(plan.to, replaceTo ?? plan.to);
  const inRange = Object.values(p.playlist.clips).filter((c) => c.start < to && c.start + c.length > plan.from);
  const old = arrangerThings(p, inRange);
  let replaced = 0;
  for (const c of inRange) {
    if (c.kind !== 'pattern' && c.start >= plan.from && old.channels.has(c.channelId)) {
      delete d.playlist.clips[c.id];
      replaced++;
    }
  }
  replaced += clearRange(d, plan.from, to, { trim: true, tempo: env.tempo }).removed;
  for (const m of Object.values(p.playlist.markers)) if (m.tick >= plan.from && m.tick < to) removeMarker(d, m.id);
  return { replaced, old };
}

/** Writes the planned pattern clips (each source on its own lane, variants derived as needed). */
function writeClips(
  d: Draft<Project>,
  plan: ArrangementPlan,
  env: ApplyEnv,
): { clipIds: ClipId[]; variants: Set<PatternId> } {
  const p = d as unknown as Project;
  const clipIds: ClipId[] = [];
  const variants = new Set<PatternId>();
  const lanes = new Map<PatternId, LaneId>();
  for (const c of plan.clips) {
    if (!p.patterns[c.source]) continue;
    let lane = lanes.get(c.source);
    if (!lane) {
      lane = laneNamed(d, p.patterns[c.source]!.name);
      lanes.set(c.source, lane);
    }
    const pid = deriveVariant(d, c.source, c.steps, env.variant);
    if (pid !== c.source) variants.add(pid);
    const clip: PatternClip = {
      kind: 'pattern',
      id: newId.clip(),
      laneId: lane,
      start: c.start,
      length: c.length,
      patternId: pid,
      offset: 0,
    };
    addClips(d, [clip]);
    clipIds.push(clip.id);
  }
  return { clipIds, variants };
}

/**
 * Writes a plan: clears its range first (`replace`), moves loop-start crashes out of the sources (except `protect`ed ones),
 * then the clips (variants derived as needed), FX, crashes, automation and markers; finally removes
 * the arranger's things the cleared range used that nothing plays any more. Returns what it did and
 * the ids of the clips it made.
 */
export function applyArrangement(
  d: Draft<Project>,
  plan: ArrangementPlan,
  env: ApplyEnv,
  opts: ApplyOptions,
): ApplyReport & { clipIds: ClipId[] } {
  let replaced = 0;
  let old: { patterns: Set<PatternId>; channels: Set<ChannelId> } = { patterns: new Set(), channels: new Set() };
  if (opts.replace) {
    const cleared = clearForPlan(d, plan, env, opts.replaceTo);
    replaced = cleared.replaced;
    old = cleared.old;
  }
  const loopCrashes = plan.loopCrashes.filter((m) => !opts.protect?.has(m.patternId));
  const movedCrashes = moveLoopCrashes(d, { loopCrashes });
  const { clipIds, variants } = writeClips(d, plan, env);
  const fx = placeFx(d, plan.fx, env);
  const crashes = placeCrashes(d, plan.crashes, env);
  const automation = placeAutomation(d, plan.automation, env);
  for (const m of plan.markers) addMarker(d, m.tick, m.name);
  collectGarbage(d, old);
  return {
    variants: variants.size,
    clips: clipIds.length,
    fx: fx.length,
    crashes: crashes.length,
    automation: automation.length,
    replaced,
    movedCrashes,
    clipIds: [...clipIds, ...fx, ...crashes, ...automation],
  };
}
