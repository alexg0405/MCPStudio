/**
 * What the AI can read about effect racks: the inside of a rack on a track (branches, effects with their settings, macros and what
 * each drives; `get_mixer` includes it) and the racks it can put on a track (the factory ones and the musician's own).
 */
import { decode, formatValue, type ParamSpec } from '@agstudio/sdk';
import { macroParamId } from '@core/model/rack';
import { MASTER, type FxSlot, type InsertId, type MacroMapping, type Project, type Rack } from '@core/model/types';
import { describeMacroTarget } from '@core/query/rack';
import { pluginInfoOf } from '../ops/automation/targets';
import { allRacks } from '../../actions/racks';
import { buildChoice } from '../../racks/build';
import { findRackChoice } from '../../racks/library';
import { macroTargetSpec } from '../../racks/targets';
import type { Services } from '../../services';
import { str } from '../ops/values';
import * as S from '../schema/parts';
import { describeParams, presetOf } from './describe';
import { projectOf, round2, tool } from './tool';

/** A mapping's end as the AI reads and writes it: the number in the target's unit, an option id for a choice. */
function endOf(spec: ParamSpec | null, value: number): number | string | boolean {
  if (!spec) return value;
  const decoded = decode(spec, value);
  return typeof decoded === 'number' ? round2(decoded) : decoded;
}

function describeMapping(services: Services, rack: Rack, mapping: MacroMapping) {
  const spec = macroTargetSpec(services, rack, mapping.target);
  const show = (value: number) => (spec ? formatValue(spec, decode(spec, value)) : String(value));
  return {
    target: describeMacroTarget(rack, mapping.target, pluginInfoOf(services)) ?? 'something that is gone',
    kind: mapping.target.kind,
    ...(mapping.target.kind === 'param' ? { effect: mapping.target.slotId, param: mapping.target.paramId } : {}),
    ...(mapping.target.kind === 'mix' ? { effect: mapping.target.slotId } : {}),
    min: endOf(spec, mapping.min),
    max: endOf(spec, mapping.max),
    sweep: `${show(mapping.min)} → ${show(mapping.max)}`,
    curve: mapping.curve,
  };
}

/** A rack slot in full: how it splits, its branches with their effects and settings, its macros and what each drives. */
export function describeRack(services: Services, project: Project, insertId: InsertId, slot: FxSlot & { rack: Rack }) {
  const { rack } = slot;
  return {
    split: rack.split,
    ...(rack.crossovers.length ? { crossovers_hz: rack.crossovers.map(round2) } : {}),
    output_db: round2(typeof slot.plugin.params.gain === 'number' ? slot.plugin.params.gain : 0),
    branches: rack.branches.map((branch, index) => ({
      n: index + 1,
      id: branch.id,
      name: branch.name,
      level_db: branch.levelDb <= -60 ? -100 : round2(branch.levelDb),
      pan: round2(branch.pan),
      ...(branch.muted ? { muted: true } : {}),
      ...(branch.solo ? { solo: true } : {}),
      effects: branch.fx.map((effect, position) => {
        const definition = services.plugins.get(effect.plugin.pluginId);
        const preset = presetOf(services, definition, effect.plugin, { kind: 'fx', insertId, slotId: effect.id });
        return {
          position: position + 1,
          id: effect.id,
          plugin: effect.plugin.pluginId,
          name: definition?.name ?? `${effect.plugin.pluginId} (missing)`,
          enabled: effect.enabled,
          mix: round2(effect.mix),
          ...(preset ? { preset } : {}),
          params: describeParams(definition, effect.plugin, false),
        };
      }),
    })),
    macros: rack.macros.map((macro, index) => {
      const raw = slot.plugin.params[macroParamId(index)];
      return {
        n: index + 1,
        id: macroParamId(index),
        name: macro.name,
        value: round2(typeof raw === 'number' ? raw : 0),
        drives: macro.mappings.map((mapping) => describeMapping(services, rack, mapping)),
      };
    }),
    note: 'Change effects in a rack with edit_effect and remove_effect (their id), branches with rack_branch, macros with rack_macro.',
  };
}

/** The mixer's note on a slot that is a rack: where `get_mixer` shows the inside. */
export const rackFields = (services: Services, project: Project, insertId: InsertId, slot: FxSlot) =>
  slot.rack ? { rack: describeRack(services, project, insertId, slot as FxSlot & { rack: Rack }) } : {};

export const getRacks = tool(
  'get_racks',
  'The effect racks add_rack can put on a mixer track (the factory racks and the musician’s own): name, what it is for and what is inside (how it splits, its branches and macros); give a rack name for one in full, with its effects, settings, macros and what each macro drives. A rack already on a track is read with get_mixer.',
  { rack: S.str('A rack name (or part of it): only that rack in full.') },
  (services, args) => {
    const all = allRacks(services);
    const wanted = str(args.rack);
    if (!wanted) {
      return {
        racks: all.map((rack) => ({ name: rack.name, source: rack.source, description: rack.description, inside: rack.summary })),
      };
    }
    const found = findRackChoice(all, wanted);
    if (!found) return { error: `there is no rack "${wanted}"`, racks: all.map((rack) => rack.name) };
    const head = { name: found.name, source: found.source, description: found.description, inside: found.summary };
    // Made as it would be put on a track (new ids and all), only to be read.
    const built = buildChoice(services, found);
    if ('error' in built) return { ...head, error: built.error };
    return { ...head, rack: describeRack(services, projectOf(services), MASTER, built.slot) };
  },
);
