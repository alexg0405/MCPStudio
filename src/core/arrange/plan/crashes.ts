import { PPQ } from '../../time/ppq';
import type { ChannelId, PatternId, Project, Tick } from '../../model/types';
import type { VariantEnv } from '../fills';
import { noteRole } from '../roles';
import type { BoundaryRecipe, EndingRecipe } from '../transitions';
import { CRASH_LANE, type LaneAllocator } from './lanes';
import type { PlannedCrash } from './types';

/** A crash within this many ticks of a pattern's start (a 1/32 note) would crash on every loop. */
const LOOP_START_TICKS = 120;
/** Crashes are at least this many bars apart. */
const CRASH_MIN_GAP_BARS = 4;
/** How long a crash rings when the caller doesn't know (s). */
export const DEFAULT_CRASH_SECONDS = 2.6;
/** The crash a phrase rule asks for at the start of a hard section's next phrase. */
export const PHRASE_CRASH_VELOCITY = 0.8;

const isCrashNote = (env: VariantEnv, channelId: ChannelId, key: number) =>
  noteRole(env.roles.get(channelId) ?? 'other', key) === 'crash';

/** Crash hits on a pattern's first 1/32 (they'd crash on every loop). */
export function loopStartCrashes(
  p: Project,
  pid: PatternId,
  env: VariantEnv,
): { channelId: ChannelId; ticks: Tick[] }[] {
  const pattern = p.patterns[pid];
  if (!pattern) return [];
  const out: { channelId: ChannelId; ticks: Tick[] }[] = [];
  for (const [key, byId] of Object.entries(pattern.notes)) {
    const channelId = key as ChannelId;
    const ticks = Object.values(byId ?? {})
      .filter((n) => n.tick < LOOP_START_TICKS && isCrashNote(env, channelId, n.key))
      .map((n) => n.tick);
    if (ticks.length) out.push({ channelId, ticks });
  }
  return out;
}

/** Ticks a crash that rings `seconds` long takes at a tempo. */
export function crashLengthTicks(seconds: number, bpm: number): Tick {
  return Math.round((seconds * bpm * PPQ) / 60);
}

/** Picks crashes so that no two (nor one and an existing crash) are closer than 4 bars. */
export class CrashPicker {
  /** The crashes taken, in the order they were offered. */
  readonly accepted: { at: Tick; velocity: number }[] = [];
  /** How many offers were turned down for being too close to another crash. */
  skipped = 0;
  private readonly minGap: Tick;

  constructor(
    barTicks: Tick,
    private readonly existing: readonly Tick[] = [],
  ) {
    this.minGap = CRASH_MIN_GAP_BARS * barTicks;
  }

  /** Takes the crash unless another one is within the minimum gap. */
  offer(at: Tick, velocity: number): void {
    const isCrowded =
      this.existing.some((t) => Math.abs(t - at) < this.minGap) ||
      this.accepted.some((c) => Math.abs(c.at - at) < this.minGap);
    if (isCrowded) {
      this.skipped++;
      return;
    }
    this.accepted.push({ at, velocity });
  }

  /** Offers the crashes the boundaries and the ending ask for. */
  offerTransitions(boundaries: readonly BoundaryRecipe[], ending: EndingRecipe | null): void {
    for (const b of boundaries) if (b.crash !== null) this.offer(b.at, b.crash);
    if (ending?.crash) this.offer(ending.crash.at, ending.crash.velocity);
  }

  /** The accepted crashes in song order, each on a lane where it doesn't overlap another. */
  placeOnLanes(lanes: LaneAllocator, lengthTicks: Tick): PlannedCrash[] {
    return this.accepted
      .sort((a, b) => a.at - b.at)
      .map((c) => ({ ...c, lane: lanes.place(CRASH_LANE, c.at, c.at + lengthTicks) }));
  }
}
