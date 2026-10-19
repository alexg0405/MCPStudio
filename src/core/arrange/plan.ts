/**
 * The arrangement plan: from sections (what plays, how long, at what energy) to everything the song
 * needs, without touching the project. Each section's beats are laid out as clips back to back (one
 * lane per source pattern); the phrase rules and the transitions add changes (fills, small changes,
 * gaps, builds), which become each clip's variant steps; the transitions add FX sounds, crashes and
 * automation, each on its own lanes so nothing overlaps; markers name the sections.
 *
 * The work is split by job in `plan/`: `arrangement.ts` plans a new song, `develop.ts` plans changes
 * to an existing one, and the rest are the pieces they share (lanes, crashes, per-clip steps,
 * section content). This file keeps the import path every caller uses.
 */
export { planArrangement } from './plan/arrangement';
export { stepsForClips } from './plan/clip-steps';
export { loopStartCrashes } from './plan/crashes';
export { planDevelop, type DevelopOptions, type DevelopPlan, type Existing } from './plan/develop';
export { AUTOMATION_LANE, CRASH_LANE, FX_LANE, LaneAllocator } from './plan/lanes';
export { thinLevel } from './plan/section-content';
export {
  eventSpan,
  type ArrangeRequest,
  type ArrangementPlan,
  type DevelopSection,
  type PlanEnv,
  type PlannedAutomation,
  type PlannedClip,
  type PlannedCrash,
  type PlannedFx,
  type SongEvent,
} from './plan/types';
