/**
 * Writing arrangements into the project (inside a History recipe): variants of the source patterns,
 * clips on named lanes, transition sounds on audio clip channels that follow the tempo, crash hits,
 * automation curves (one channel per purpose, control and length, reused), markers. Also the
 * in-place edits `develop`, `transition` and `vary` make to an existing song (clips re-pointed to
 * variants, looping clips split so one repeat can change alone), rebuilding variants whose source
 * changed, and removing what the arranger made that nothing uses any more. Plain loops on the
 * draft throughout (memoized queries would go stale).
 *
 * The work is split by job in `apply/`: variants, lanes, sounds (FX and crashes), automation,
 * clean-up, whole arrangements and in-place edits. This file keeps the import path every caller uses.
 */
export { applyArrangement, type ApplyOptions } from './apply/arrangement';
export { ARRANGER_AUTOMATION, automationPoints, placeAutomation, resolveAutomationTarget } from './apply/automation';
export { collectGarbage, moveLoopCrashes } from './apply/cleanup';
export { applyEditsInPlace } from './apply/in-place';
export { laneAllocatorFor, laneNamed } from './apply/lanes';
export { placeCrashes, placeFx } from './apply/sounds';
export type { ApplyEnv, ApplyReport, SweepTargets } from './apply/types';
export { deriveVariant, refreshVariants, rootOf } from './apply/variants';
