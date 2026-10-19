import type { Tick } from '../../model/types';
import type { FxPlacement } from '../transitions';

/** The lane each kind of FX sound goes on (several kinds share "FX swells"). */
export const FX_LANE: Record<FxPlacement['kind'], string> = {
  riser: 'FX risers',
  'reverse-crash': 'FX swells',
  downlifter: 'FX swells',
  whoosh: 'FX swells',
  impact: 'FX hits',
  'sub-drop': 'FX sub',
};
export const CRASH_LANE = 'Crashes';
export const AUTOMATION_LANE = 'Automation';

/** The most lanes tried per group before giving up and using "<group> 99". */
const MAX_LANES_PER_GROUP = 100;

/** Lane names by group, so clips placed on one never overlap ("FX swells", "FX swells 2"…). */
export class LaneAllocator {
  private readonly busy = new Map<string, [Tick, Tick][]>();

  /** `numbered` groups name even their first lane with a number ("Automation 1"). */
  constructor(private readonly numbered: ReadonlySet<string> = new Set([AUTOMATION_LANE])) {}

  /** Marks a span busy on a lane (clips already there). */
  occupy(lane: string, start: Tick, end: Tick): void {
    const list = this.busy.get(lane) ?? [];
    list.push([start, end]);
    this.busy.set(lane, list);
  }

  /** The first lane of the group that is free over [start, end), marked busy from now on. */
  place(group: string, start: Tick, end: Tick): string {
    for (let i = 1; i < MAX_LANES_PER_GROUP; i++) {
      const name = this.laneName(group, i);
      const list = this.busy.get(name) ?? [];
      if (list.every(([a, b]) => b <= start || a >= end)) {
        this.occupy(name, start, end);
        return name;
      }
    }
    return `${group} 99`;
  }

  private laneName(group: string, number: number): string {
    if (this.numbered.has(group) || number > 1) return `${group} ${number}`;
    return group;
  }
}
