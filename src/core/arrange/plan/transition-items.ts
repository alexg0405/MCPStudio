import type { Style } from '../../beat/style';
import { PPQ } from '../../time/ppq';
import type { Tick } from '../../model/types';
import { FILL_ROTATION } from '../phrases';
import type { SectionSpan } from '../sections';
import type { AutomationItem, BoundaryRecipe, EndingRecipe, FxPlacement } from '../transitions';
import { FILL_KINDS } from '../variants';
import { AUTOMATION_LANE, FX_LANE, type LaneAllocator } from './lanes';
import type { PlanCounts, PlannedAutomation, PlannedFx, SongEvent } from './types';

/** Every FX sound the boundaries and the ending ask for, in song order. */
export function fxOfTransitions(boundaries: readonly BoundaryRecipe[], ending: EndingRecipe | null): FxPlacement[] {
  return [...boundaries.flatMap((b) => b.fx), ...(ending?.fx ?? [])].sort((a, b) => a.start - b.start);
}

/** Every automation curve the boundaries and the ending ask for, in song order. */
export function automationOfTransitions(
  boundaries: readonly BoundaryRecipe[],
  ending: EndingRecipe | null,
): AutomationItem[] {
  return [...boundaries.flatMap((b) => b.automation), ...(ending?.automation ?? [])].sort((a, b) => a.start - b.start);
}

/** An FX sound with its length in ticks and the lane it goes on (the first one free over its span). */
export function placeFxSound(fx: FxPlacement, lanes: LaneAllocator): PlannedFx {
  const length = Math.round(fx.beats * PPQ);
  return { ...fx, length, lane: lanes.place(FX_LANE[fx.kind], fx.start, fx.start + length) };
}

/** An automation curve on the first "Automation N" lane that is free over its span. */
export function placeCurve(item: AutomationItem, lanes: LaneAllocator): PlannedAutomation {
  return { ...item, lane: lanes.place(AUTOMATION_LANE, item.start, item.start + item.length) };
}

/** Fills in song order take the style's rotation in turn (sections that chose a fill keep it). */
export function rotateFills(events: SongEvent[], sections: readonly SectionSpan[], style: Style): void {
  const rotation = FILL_ROTATION[style];
  let next = 0;
  for (const event of [...events].sort((a, b) => a.from - b.from)) {
    if (!FILL_KINDS.has(event.kind) || event.kind === 'snare-build' || sections[event.section]?.fill !== 'auto')
      continue;
    event.kind = rotation[next++ % rotation.length]!;
  }
}

/** The numbers a summary line quotes: fills, builds with what they hold, breakdowns. */
export function planCounts(events: readonly SongEvent[], boundaries: readonly BoundaryRecipe[]): PlanCounts {
  return {
    fills: events.filter((e) => FILL_KINDS.has(e.kind) && e.kind !== 'snare-build').length,
    builds: boundaries
      .filter((b) => b.kind === 'rise')
      .map((b) => ({
        riser: b.fx.some((f) => f.kind === 'riser'),
        gap: b.end.some((e) => e.kind === 'gap'),
        impact: b.fx.some((f) => f.kind === 'impact'),
      })),
    breakdowns: boundaries.filter((b) => b.kind === 'fall').length,
  };
}

/** The tick an FX sound is heard at: risers and reverse crashes lead into their end, the rest start there. */
export function fxHeardAt(fx: FxPlacement, lengthTicks: Tick): Tick {
  return fx.kind === 'riser' || fx.kind === 'reverse-crash' ? fx.start + lengthTicks : fx.start;
}
