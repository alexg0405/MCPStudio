/**
 * Hooks each macro knob of a rack onto what it is mapped to. A macro is a parameter of the rack (with its own `AutoLane`:
 * the document's value, the automation, a MIDI controller); a mapped target's lane *follows* that lane through the
 * mapping's range and curve (`AutoLane.follow`), so the knob, its automation and its controller move the target
 * sample-accurately, offline renders included, and a target that is hooked ignores its own document value and automation.
 */
import { isBentMapping, macroTargetValue } from '@core/rack/mapping';
import type { MacroMapping, MacroTarget, RackMacro } from '@core/model/types';
import type { AutoLane } from '../param-lane';

/** One hook: which macro drives which lane, and the mapping it was made from. */
interface Link {
  macro: number;
  /** The macro's lane, the one followed. */
  source: AutoLane;
  /** The target's lane, the one that follows. */
  lane: AutoLane;
  /** The mapping as text, to tell whether it changed. */
  mapping: string;
  stop: (release?: boolean) => void;
}

/** A string that is the same for the same target (a target has at most one macro). */
function targetKey(target: MacroTarget): string {
  switch (target.kind) {
    case 'param':
      return `param:${target.slotId}:${target.paramId}`;
    case 'mix':
      return `mix:${target.slotId}`;
    case 'branch':
      return `branch:${target.branchId}:${target.param}`;
    case 'crossover':
      return `crossover:${target.index}`;
    case 'gain':
      return 'gain';
  }
}

/** The hooks of one rack. */
export class MacroLinks {
  private readonly links = new Map<string, Link>();

  constructor(
    /** The lane of macro `index` (0-based), or null when it has none. */
    private readonly macroLane: (index: number) => AutoLane | null,
    /** The lane a target is driven through, or null while it does not exist (an effect still loading). */
    private readonly laneOf: (target: MacroTarget) => AutoLane | null,
  ) {}

  /** How many targets are hooked now. */
  get size(): number {
    return this.links.size;
  }

  /**
   * Makes the hooks match the macros: new mappings are hooked, changed ones hooked again, removed ones let go (the target
   * goes back to its own value). A target that cannot be found yet is tried again at the next call.
   */
  sync(macros: readonly RackMacro[]): void {
    const wanted = new Map<string, { macro: number; mapping: MacroMapping }>();
    macros.forEach((macro, index) => {
      for (const mapping of macro.mappings) wanted.set(targetKey(mapping.target), { macro: index, mapping });
    });
    for (const [key, link] of this.links) {
      const want = wanted.get(key);
      const isCurrent =
        want !== undefined &&
        link.lane.following &&
        link.macro === want.macro &&
        link.mapping === JSON.stringify(want.mapping) &&
        link.source === this.macroLane(want.macro) &&
        link.lane === this.laneOf(want.mapping.target);
      if (isCurrent) continue;
      // A lane that is gone (its effect was replaced) has already let go; one that is still there goes back to its value.
      link.stop(link.lane.following);
      this.links.delete(key);
    }
    for (const [key, want] of wanted) {
      if (this.links.has(key)) continue;
      const lane = this.laneOf(want.mapping.target);
      const source = this.macroLane(want.macro);
      if (!lane || !source) continue;
      const { spec } = lane;
      const stop = lane.follow(source, (macro) => macroTargetValue(spec, want.mapping, macro), {
        bent: isBentMapping(spec, want.mapping.curve),
      });
      this.links.set(key, { macro: want.macro, source, lane, mapping: JSON.stringify(want.mapping), stop });
    }
  }

  /** Lets go of everything (the rack is going away, so the targets are not given their own values back). */
  dispose(): void {
    for (const link of this.links.values()) link.stop(false);
    this.links.clear();
  }
}
