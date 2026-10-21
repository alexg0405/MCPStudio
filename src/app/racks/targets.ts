/**
 * What a macro can be mapped to, seen from the app: the spec of a target (an effect's own parameter spec, or the built-in one
 * of a branch level, a crossover…), where the target is now in the document, and the mapping a new macro starts with.
 */
import { encode, type ParamSpec } from '@agstudio/sdk';
import type { FxSlot, MacroMapping, MacroTarget, Rack } from '@core/model/types';
import { builtInTargetSpec, startingRange } from '@core/rack/mapping';
import type { Services } from '../services';

/** The inner effect a param or mix target points at. */
function innerSlotOf(rack: Rack, slotId: string): FxSlot | undefined {
  for (const branch of rack.branches) {
    const found = branch.fx.find((slot) => slot.id === slotId);
    if (found) return found;
  }
  return undefined;
}

/** The spec of a target: an effect's parameter from its plugin, the others built in. Null when it cannot be found. */
export function macroTargetSpec(s: Pick<Services, 'plugins'>, rack: Rack, target: MacroTarget): ParamSpec | null {
  if (target.kind !== 'param') return builtInTargetSpec(target);
  const slot = innerSlotOf(rack, target.slotId);
  const def = slot ? s.plugins.get(slot.plugin.pluginId) : undefined;
  return def?.params[target.paramId] ?? null;
}

/** The target's value in the document now, in the numeric encoding mappings use (an option number, 0 or 1). */
export function macroTargetNow(rackSlot: FxSlot & { rack: Rack }, target: MacroTarget, spec: ParamSpec): number {
  const rack = rackSlot.rack;
  switch (target.kind) {
    case 'param': {
      const raw = innerSlotOf(rack, target.slotId)?.plugin.params[target.paramId];
      return encode(spec, raw ?? spec.default);
    }
    case 'mix':
      return innerSlotOf(rack, target.slotId)?.mix ?? 1;
    case 'branch': {
      const branch = rack.branches.find((candidate) => candidate.id === target.branchId);
      return (target.param === 'level' ? branch?.levelDb : branch?.pan) ?? 0;
    }
    case 'crossover':
      return rack.crossovers[target.index] ?? encode(spec, spec.default);
    case 'gain': {
      const raw = rackSlot.plugin.params.gain;
      return typeof raw === 'number' ? raw : 0;
    }
  }
}

/** The mapping a macro gets for a target when the musician just maps it: it starts at the target's value and sweeps the room it has. */
export function startingMapping(s: Pick<Services, 'plugins'>, rackSlot: FxSlot & { rack: Rack }, target: MacroTarget): MacroMapping | null {
  const spec = macroTargetSpec(s, rackSlot.rack, target);
  if (!spec) return null;
  const range = startingRange(spec, macroTargetNow(rackSlot, target, spec));
  return { target, min: range.min, max: range.max, curve: 'linear' };
}
