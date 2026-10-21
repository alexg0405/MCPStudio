/**
 * Making a rack slot from a rack you can pick: a factory recipe (`factory.ts`) or one you saved (`.agrack`, `core/rack`).
 * Either gives a fresh slot with new ids, ready to go on an insert.
 */
import { macroParamId, makeFxSlot, makeRackSlot } from '@core/model/rack';
import type { FxSlot, MacroMapping, MacroTarget, Rack } from '@core/model/types';
import { rackFilePluginIds, rackFileToSlot } from '@core/rack/file';
import { instanceFor } from '../mix/setup';
import type { Services } from '../services';
import { FACTORY_RACKS, type FactoryRack, type RecipeMapping, type RecipeTarget } from './factory';
import type { RackChoice, UserRack } from './library';

/** A rack made from a choice, or why it could not be made. */
export type BuiltRack = { slot: FxSlot & { rack: Rack } } | { error: string };

/** The target a recipe names, found in the rack that was just built (null when it points at nothing there). */
function targetOf(rack: Rack, to: RecipeTarget): MacroTarget | null {
  if ('gain' in to) return { kind: 'gain' };
  if ('crossover' in to) return { kind: 'crossover', index: to.crossover };
  if ('branch' in to) {
    const branch = rack.branches[to.branch];
    return branch ? { kind: 'branch', branchId: branch.id, param: to.param } : null;
  }
  const [branchIndex, fxIndex] = 'mix' in to ? to.mix : to.fx;
  const inner = rack.branches[branchIndex]?.fx[fxIndex];
  if (!inner) return null;
  return 'mix' in to ? { kind: 'mix', slotId: inner.id } : { kind: 'param', slotId: inner.id, paramId: to.param };
}

function mappingOf(rack: Rack, map: RecipeMapping, s: Services): MacroMapping | string {
  const target = targetOf(rack, map.to);
  if (!target) return 'a macro points at an effect that is not in the rack';
  if (target.kind === 'param') {
    const inner = rack.branches.flatMap((branch) => branch.fx).find((fx) => fx.id === target.slotId);
    const def = inner ? s.plugins.get(inner.plugin.pluginId) : undefined;
    if (!def?.params[target.paramId]) return `a macro points at “${target.paramId}”, which ${def?.name ?? 'the effect'} does not have`;
  }
  return { target, min: map.min, max: map.max, curve: map.curve ?? 'linear' };
}

/** Builds a factory rack: its effects with their settings, its branches, crossovers, macro names, mappings and values. */
export function buildFactoryRack(s: Services, recipe: FactoryRack): BuiltRack {
  const slot = makeRackSlot(recipe.split, recipe.branches.length) as FxSlot & { rack: Rack };
  const rack = slot.rack;
  recipe.branches.forEach((branchRecipe, index) => {
    const branch = rack.branches[index];
    if (!branch) return;
    branch.name = branchRecipe.name;
    branch.levelDb = branchRecipe.levelDb ?? 0;
    branch.pan = branchRecipe.pan ?? 0;
  });
  if (recipe.crossovers) rack.crossovers = [...recipe.crossovers];
  for (const [index, branchRecipe] of recipe.branches.entries()) {
    for (const fx of branchRecipe.fx) {
      const instance = instanceFor(s, fx);
      if (!instance) return { error: `“${fx.label}” is not installed (${fx.pluginId}), so “${recipe.name}” cannot be made.` };
      const inner = makeFxSlot(instance);
      if (fx.mix !== undefined) inner.mix = fx.mix;
      if (fx.enabled === false) inner.enabled = false;
      (rack.branches[index] as Rack['branches'][number]).fx.push(inner);
    }
  }
  slot.plugin.params.gain = recipe.gainDb ?? 0;
  for (const [index, macroRecipe] of recipe.macros.entries()) {
    const macro = rack.macros[index];
    if (!macro) break;
    macro.name = macroRecipe.name;
    slot.plugin.params[macroParamId(index)] = macroRecipe.value;
    for (const map of macroRecipe.maps) {
      const mapping = mappingOf(rack, map, s);
      if (typeof mapping === 'string') return { error: `${recipe.name}: ${mapping}.` };
      macro.mappings.push(mapping);
    }
  }
  return { slot };
}

/** Builds a rack you saved; every effect in it has to be installed. */
export function buildUserRack(s: Services, mine: UserRack): BuiltRack {
  for (const pluginId of rackFilePluginIds(mine.file)) {
    const def = s.plugins.get(pluginId);
    if (!def) return { error: `“${mine.file.name}” uses a plugin that is not installed (${pluginId}).` };
    if (def.kind !== 'effect') return { error: `“${mine.file.name}” has “${def.name}” in it, which is not an effect.` };
  }
  return { slot: rackFileToSlot(mine.file) };
}

/** Builds the rack a choice stands for. */
export function buildChoice(s: Services, choice: RackChoice): BuiltRack {
  if (choice.source === 'user') {
    const mine = choice.id ? s.presets.getRack(choice.id) : undefined;
    return mine ? buildUserRack(s, mine) : { error: `“${choice.name}” is not in your racks any more.` };
  }
  const recipe = FACTORY_RACKS.find((rack) => rack.name === choice.name);
  return recipe ? buildFactoryRack(s, recipe) : { error: `There is no factory rack called “${choice.name}”.` };
}
