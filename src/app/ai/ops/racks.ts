/** Effect racks: put one on a track, change how it splits, fill its branches, set and map its macros, group effects, save it. */
import { current, isDraft, type Draft } from 'immer';
import { makePluginInstance } from '@core/model/defaults';
import { MACRO_COUNT, RACK_GAIN_MAX_DB, RACK_GAIN_MIN_DB, RACK_PLUGIN_ID, macroParamId } from '@core/model/rack';
import type { BranchId, FxSlot, InsertId, MacroCurve, MacroMapping, MacroTarget, Rack, RackBranch, RackSplit, SlotId } from '@core/model/types';
import { setFxSlotEnabled, setFxSlotMix } from '@core/ops/mixer';
import {
  addBranch,
  addRackFx,
  addRackSlot,
  clearMacro,
  groupIntoRack,
  insertRackSlot,
  moveBranch,
  moveRackFx,
  removeBranch,
  removeMacroMapping,
  renameMacro,
  setBranch,
  setCrossovers,
  setMacroMapping,
  setRackSplit,
  ungroupRack,
} from '@core/ops/racks';
import { insertLabel } from '@core/query/mixer';
import { describeMacroTarget } from '@core/query/rack';
import { rackSlotToFile } from '@core/rack/file';
import { encode, defaultValues, type ParamSpec, type ParamSpecs } from '@agstudio/sdk';
import { buildChoice } from '../../racks/build';
import { findRackChoice, rackChoices } from '../../racks/library';
import { macroTargetSpec, startingMapping } from '../../racks/targets';
import * as S from '../schema/parts';
import { fail, type OpContext, type OpModule } from './context';
import { pluginInfoOf } from './automation/targets';
import { bool, coerceParam, findParamId, isObj, lower, num, r2, str } from './values';

const SPLITS = ['parallel', 'bands', 'midside', 'leftright'] as const;
const CURVES = ['linear', 'exponential', 'inverted'] as const;
const TARGET_KINDS = ['param', 'effect_mix', 'branch_level', 'branch_pan', 'crossover', 'output'] as const;

const RACK = S.str('A rack: the id (fx_…) of its slot on the mixer track, or @ref of one added earlier in this answer.');
const BRANCH = S.str('A branch (or band): its number in the rack ("1" is the first), its name, or its id (br_…).');

/** What a macro drives or lets go: the thing, and (for map) how far it sweeps. */
const MACRO_TARGET = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: [...TARGET_KINDS],
      description:
        'param: a setting of an effect in the rack (uses "effect" and "param"); effect_mix: an effect’s dry/wet ("effect", 0–1); branch_level: a branch’s level in dB ("branch"); branch_pan: a branch’s pan −1…1 ("branch"); crossover: a crossover frequency in Hz of a bands rack ("crossover" = its number, 1 is the lowest); output: the rack’s output gain in dB.',
    },
    effect: S.str('An effect inside the rack: its id (fx_…) or @ref.'),
    param: S.str('For kind param: the setting’s id from the catalog.'),
    branch: BRANCH,
    crossover: S.int('For kind crossover: its number (1 = the lowest).'),
    min: S.VALUE('Where the target is with the macro at 0 (in the target’s own unit; an option id for a choice). Left out: where it is now.'),
    max: S.VALUE('Where the target is with the macro at 1. Left out: the end of its range that is further from where it is now.'),
    curve: { type: 'string', enum: [...CURVES], description: 'linear (default): the knob and the setting move together; exponential: slow at first, faster toward the end; inverted: backwards.' },
  },
  required: ['kind'],
};

/** The rack slot an action names, in the draft. */
function rackIn(c: OpContext, raw: unknown): { insertId: InsertId; slotId: SlotId; slot: Draft<FxSlot> & { rack: Draft<Rack> } } {
  const { insertId, slotId } = c.effect(raw);
  const slot = c.draft.mixer.inserts[insertId]?.fx.find((candidate) => candidate.id === slotId);
  if (!slot?.rack || slot.plugin.pluginId !== RACK_PLUGIN_ID) {
    return fail(`${String(raw)} is not a rack (add_rack puts one on a track)`);
  }
  return { insertId, slotId, slot: slot as Draft<FxSlot> & { rack: Draft<Rack> } };
}

/** A branch by number (1-based), id, exact name or the only branch whose name contains the text. */
function branchIn(rack: Draft<Rack>, raw: unknown): Draft<RackBranch> {
  const text = str(raw) ?? (typeof raw === 'number' ? String(raw) : fail('which branch?'));
  const byId = rack.branches.find((branch) => branch.id === text);
  if (byId) return byId;
  const number = /^#?(\d+)$/.exec(text);
  if (number) return rack.branches[Number(number[1]) - 1] ?? fail(`the rack has no branch ${number[1]} (it has ${rack.branches.length})`);
  const wanted = lower(text);
  const exact = rack.branches.filter((branch) => lower(branch.name) === wanted);
  if (exact.length === 1) return exact[0] as Draft<RackBranch>;
  const partial = rack.branches.filter((branch) => lower(branch.name).includes(wanted));
  if (partial.length === 1) return partial[0] as Draft<RackBranch>;
  return fail(`the rack has no branch "${text}" (branches: ${rack.branches.map((branch) => branch.name).join(', ')})`);
}

/** A macro by number (1–8) or name. */
function macroIndexIn(rack: Draft<Rack>, raw: unknown): number {
  const text = str(raw) ?? (typeof raw === 'number' ? String(raw) : fail('which macro?'));
  const number = /^(?:macro\s*)?(\d)$/i.exec(text);
  if (number && Number(number[1]) >= 1 && Number(number[1]) <= MACRO_COUNT) return Number(number[1]) - 1;
  const wanted = lower(text);
  const exact = rack.macros.findIndex((macro) => lower(macro.name) === wanted);
  if (exact >= 0) return exact;
  const partial = rack.macros.map((macro, index) => (lower(macro.name).includes(wanted) ? index : -1)).filter((index) => index >= 0);
  return partial.length === 1 ? (partial[0] as number) : fail(`the rack has no macro "${text}" (macros 1 to ${MACRO_COUNT})`);
}

/** The target a macro entry names. */
function targetOf(c: OpContext, rack: Draft<Rack>, entry: Record<string, unknown>): MacroTarget {
  const kind = str(entry.kind);
  switch (kind) {
    case 'param':
    case 'effect_mix': {
      const { slotId } = c.effect(entry.effect);
      if (!rack.branches.some((branch) => branch.fx.some((fx) => fx.id === slotId))) fail(`that effect is not inside this rack`);
      if (kind === 'effect_mix') return { kind: 'mix', slotId };
      const inner = rack.branches.flatMap((branch) => branch.fx).find((fx) => fx.id === slotId) as FxSlot;
      const def = c.services.plugins.get(inner.plugin.pluginId) ?? fail(`the plugin ${inner.plugin.pluginId} is not installed`);
      const name = str(entry.param) ?? fail('which setting should the macro move?');
      const paramId = findParamId(def.params as ParamSpecs, name) ?? fail(`${def.name} has no setting "${name}"`);
      return { kind: 'param', slotId, paramId };
    }
    case 'branch_level':
    case 'branch_pan':
      return { kind: 'branch', branchId: branchIn(rack, entry.branch).id as BranchId, param: kind === 'branch_level' ? 'level' : 'pan' };
    case 'crossover': {
      const n = num(entry.crossover) ?? fail('which crossover? (1 is the lowest)');
      return { kind: 'crossover', index: Math.round(n) - 1 };
    }
    case 'output':
      return { kind: 'gain' };
    default:
      return fail(`a macro can move: ${TARGET_KINDS.join(', ')}`);
  }
}

/** A range end the AI wrote, as the number a mapping stores (an option id becomes its number). */
function endValue(spec: ParamSpec, raw: unknown): number | null {
  const value = coerceParam(spec, raw);
  return value === null ? null : encode(spec, value);
}

/** The mapping an entry describes: the range it gives, else one that starts where the target is now. */
function mappingOf(c: OpContext, rackSlot: FxSlot & { rack: Rack }, entry: Record<string, unknown>, rack: Draft<Rack>): MacroMapping {
  const target = targetOf(c, rack, entry);
  const spec = macroTargetSpec(c.services, rackSlot.rack, target) ?? fail('that cannot be mapped');
  const start = startingMapping(c.services, rackSlot, target) ?? fail('that cannot be mapped');
  const min = entry.min === undefined ? start.min : (endValue(spec, entry.min) ?? fail(`can't use ${JSON.stringify(entry.min)} as a minimum`));
  const max = entry.max === undefined ? start.max : (endValue(spec, entry.max) ?? fail(`can't use ${JSON.stringify(entry.max)} as a maximum`));
  const curve = lower(str(entry.curve) ?? 'linear');
  return { target, min, max, curve: (CURVES as readonly string[]).includes(curve) ? (curve as MacroCurve) : 'linear' };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** A plain copy to read from: a draft is unwrapped; a thing made earlier in the same recipe is not a draft yet and is already plain. */
const plain = <T>(value: T): T => (isDraft(value) ? (current(value as Draft<T>) as T) : value);

export const racks: OpModule = {
  schemas: [
    S.op(
      'add_rack',
      'Puts an effect rack on a mixer track: a container of effects that splits the sound into parallel branches (or frequency bands, mid/side, left/right), with eight macro knobs that move many settings at once. Name a rack from the catalog for a ready-made one with its macros mapped, or leave "rack" out for an empty one to fill with rack_effect and rack_macro.',
      {
        ref: S.REF,
        insert: S.INSERT,
        rack: S.str('A rack name from the catalog ("Parallel NY compression", "Multiband saturation", "Mid/side widener", "Dub delay throws with macro", "Lo-fi tape with macro", or one of the musician’s own).'),
        split: { type: 'string', enum: [...SPLITS], description: 'For an empty rack: how it splits its input (default parallel).' },
        branches: S.int('For an empty rack: how many branches or bands (1–4; mid/side and left/right have two).'),
        position: S.int('1-based slot position (default: after the last).'),
      },
      ['insert'],
    ),
    S.op(
      'edit_rack',
      'Changes a rack: how it splits its input, its crossover frequencies, its dry/wet, its output gain, bypass, or takes it apart (ungroup: its effects go back on the track in its place).',
      {
        rack: RACK,
        split: { type: 'string', enum: [...SPLITS], description: 'parallel: every branch hears the input (an empty branch is the dry sound); bands: frequency bands, lowest first; midside: branch 1 hears the mid, branch 2 the side; leftright: branch 1 the left channel, 2 the right.' },
        crossovers_hz: { type: 'array', items: { type: 'number' }, description: 'For a bands rack: the crossover frequencies in Hz, lowest first (one fewer than there are bands).' },
        mix: S.num('The rack’s dry/wet 0..1.'),
        output_db: S.num('The rack’s output gain in dB (−24…+12).'),
        enabled: S.bool('false bypasses the whole rack.'),
        ungroup: S.bool('true takes the rack apart.'),
      },
      ['rack'],
    ),
    S.op(
      'rack_branch',
      'Adds, changes or removes a branch (or band) of a rack. A bands rack adds a new top band; mid/side and left/right always have two branches.',
      {
        rack: RACK,
        action: { type: 'string', enum: ['add', 'edit', 'remove'] },
        branch: BRANCH,
        name: S.str('The branch’s name.'),
        level_db: S.num('Level in dB (−60 is silent, up to +6).'),
        pan: S.num('−1 … 1.'),
        mute: S.bool('Mute the branch.'),
        solo: S.bool('Solo it (only soloed branches sound).'),
        position: S.int('For a parallel rack: move the branch to this 1-based place.'),
      },
      ['rack', 'action'],
    ),
    S.op(
      'rack_effect',
      'Adds an effect to a branch of a rack, or (with "effect") moves one of the rack’s effects to another branch. Change or remove an effect in a rack with edit_effect and remove_effect, using its id or @ref.',
      {
        ref: S.REF,
        rack: RACK,
        branch: BRANCH,
        plugin: S.PLUGIN,
        preset: S.PRESET,
        params: S.PARAMS,
        mix: S.num('Dry/wet 0..1 (default 1).'),
        enabled: S.bool('false to add it bypassed.'),
        position: S.int('1-based place in the branch (default: last).'),
        effect: S.str('To move an effect already in the rack: its id (fx_…) or @ref (then leave out "plugin").'),
      },
      ['rack', 'branch'],
    ),
    S.op(
      'rack_macro',
      'Works on one of a rack’s eight macro knobs: names it, sets its value, maps it to what it moves (settings, an effect’s dry/wet, a branch’s level or pan, a crossover, the rack’s output) with a range and a curve, takes mappings off or clears it. A macro can move any number of things; a thing follows one macro. Automate a macro with the automation action (plugin setting "macro1" … "macro8" of the rack).',
      {
        rack: RACK,
        macro: S.str('Which macro: 1 to 8, or its name.'),
        name: S.str('A new name for the macro ("Throw", "Squash").'),
        value: S.num('The knob’s position 0..1.'),
        map: { type: 'array', items: MACRO_TARGET, description: 'Things this macro moves from now on, each with the range it sweeps (min at the knob’s 0, max at its 1).' },
        unmap: { type: 'array', items: MACRO_TARGET, description: 'Things to take off this macro (only kind and what it names matter).' },
        clear: S.bool('true takes every mapping off the macro.'),
      },
      ['rack', 'macro'],
    ),
    S.op(
      'group_into_rack',
      'Puts effects of one mixer track into a new rack (one branch holding them in their order, at the first one’s place), so they can get macros and parallel branches. Effects with a sidechain input cannot go in.',
      { ref: S.REF, insert: S.INSERT, effects: { type: 'array', items: S.EFFECT, description: 'The effects of that track to put in the rack, by id or @ref.' } },
      ['insert', 'effects'],
    ),
    S.op(
      'save_rack',
      'Saves a rack, with every effect, setting, macro and mapping, as one of the musician’s own racks (add_rack can put it on any track later). A rack of the same name is replaced.',
      { rack: RACK, name: S.str('The rack’s name, e.g. "My drum crush".'), description: S.str('What it is for, in a sentence.') },
      ['rack', 'name'],
    ),
  ],
  prompt: {
    id: 'racks',
    order: 27,
    text: `Effect racks (add_rack, edit_rack, rack_branch, rack_effect, rack_macro, group_into_rack, save_rack):
- A rack is one effect slot that holds a small graph of effects: parallel branches (an empty branch is the dry sound), frequency bands (crossovers), mid/side or left/right, each branch a chain of effects with its own level, pan, mute and solo. Branches line up in time by themselves. Eight macro knobs move many settings at once.
- For a classic rack name one from the catalog with add_rack (parallel compression, multiband saturation, a mid/side widener, dub delay throws, lo-fi tape): it comes with its macros mapped. Build your own with add_rack (split, branches), rack_effect per effect, rack_macro to name and map the macros. get_mixer shows what is inside a rack.
- Macros are for what a musician would want to turn: map "Drive" to the saturators of every band, "Throw" to an echo branch's level, "Wear" to several lo-fi settings together. Give each macro a plain name and map its range (min at the knob's 0, max at 1).
- A macro is a setting of the rack ("macro1" … "macro8"), so automation and the value work as for any effect. Effects in a rack are changed with edit_effect/remove_effect by their id or @ref.`,
  },
  handlers: {
    add_rack: (action, context) => {
      const { draft, services, project } = context;
      const insertId = context.insert(action.insert);
      const position = num(action.position);
      const index = position !== undefined ? position - 1 : undefined;
      const named = str(action.rack);
      if (named) {
        const choice = findRackChoice(rackChoices(services.presets.racks()), named) ?? fail(`there is no rack "${named}" (the catalog lists them)`);
        const built = buildChoice(services, choice);
        if ('error' in built) return fail(built.error);
        if (!insertRackSlot(draft, insertId, built.slot, index)) fail(`${insertLabel(project, insertId)} has no free effect slot`);
        context.remember(action.ref, { kind: 'effect', insertId, slotId: built.slot.id });
        const macros = built.slot.rack.macros.filter((macro) => macro.mappings.length > 0).map((macro, i) => `${i + 1} ${macro.name}`);
        return `Put the rack “${choice.name}” on ${insertLabel(project, insertId)}${macros.length ? ` (macros: ${macros.join(', ')})` : ''}`;
      }
      const splitText = lower(str(action.split) ?? 'parallel');
      const split = (SPLITS as readonly string[]).includes(splitText) ? (splitText as RackSplit) : fail(`a rack splits as: ${SPLITS.join(', ')}`);
      const slotId = addRackSlot(draft, insertId, { split, branches: Math.round(num(action.branches) ?? 0), ...(index !== undefined ? { index } : {}) });
      if (!slotId) fail(`${insertLabel(project, insertId)} has no free effect slot`);
      context.remember(action.ref, { kind: 'effect', insertId, slotId: slotId! });
      return `Added an empty ${split} rack to ${insertLabel(project, insertId)}`;
    },

    edit_rack: (action, context) => {
      const { draft, project } = context;
      const { insertId, slotId, slot } = rackIn(context, action.rack);
      const out: string[] = [];
      if (bool(action.ungroup) === true) {
        const result = ungroupRack(draft, insertId, slotId);
        if (!result.ok) fail(result.reason);
        return `Took the rack apart on ${insertLabel(project, insertId)}: its effects are on the track`;
      }
      const splitText = str(action.split);
      if (splitText) {
        const split = lower(splitText);
        if (!(SPLITS as readonly string[]).includes(split)) fail(`a rack splits as: ${SPLITS.join(', ')}`);
        setRackSplit(draft, insertId, slotId, split as RackSplit);
        out.push(`split ${split}`);
      }
      if (Array.isArray(action.crossovers_hz)) {
        const hz = action.crossovers_hz.filter((value): value is number => typeof value === 'number');
        if (!setCrossovers(draft, insertId, slotId, hz)) fail(`crossovers_hz needs ${Math.max(0, slot.rack.branches.length - 1)} frequencies, lowest first, in a bands rack`);
        out.push(`crossovers ${hz.map((value) => `${Math.round(value)} Hz`).join(', ')}`);
      }
      const mix = num(action.mix);
      if (mix !== undefined) {
        setFxSlotMix(draft, insertId, slotId, mix > 1 && mix <= 100 ? mix / 100 : mix);
        out.push(`mix ${Math.round(slot.mix * 100)}%`);
      }
      const output = num(action.output_db);
      if (output !== undefined) {
        slot.plugin.params.gain = Math.min(RACK_GAIN_MAX_DB, Math.max(RACK_GAIN_MIN_DB, output));
        out.push(`output ${r2(output)} dB`);
      }
      const enabled = bool(action.enabled);
      if (enabled !== undefined) {
        setFxSlotEnabled(draft, insertId, slotId, enabled);
        out.push(enabled ? 'on' : 'bypassed');
      }
      return out.length ? `Rack on ${insertLabel(project, insertId)}: ${out.join(', ')}` : null;
    },

    rack_branch: (action, context) => {
      const { draft, project } = context;
      const { insertId, slotId, slot } = rackIn(context, action.rack);
      const what = lower(str(action.action) ?? '');
      const where = `rack on ${insertLabel(project, insertId)}`;
      if (what === 'add') {
        const id = addBranch(draft, insertId, slotId, { ...(str(action.name) ? { name: str(action.name) as string } : {}) });
        if (!id) return fail(`a ${slot.rack.split} rack cannot have more branches (${slot.rack.branches.length})`);
        const apply = settingsOf(action);
        if (Object.keys(apply).length) setBranch(draft, insertId, slotId, id, apply);
        return `Added the branch “${slot.rack.branches.find((branch) => branch.id === id)?.name}” to the ${where}`;
      }
      const branch = branchIn(slot.rack, action.branch);
      if (what === 'remove') {
        const name = branch.name;
        if (!removeBranch(draft, insertId, slotId, branch.id)) fail(`a ${slot.rack.split} rack needs at least ${slot.rack.branches.length} branches`);
        return `Removed the branch “${name}” from the ${where}`;
      }
      if (what !== 'edit') return fail('rack_branch: action is add, edit or remove');
      const out: string[] = [];
      const settings = settingsOf(action);
      setBranch(draft, insertId, slotId, branch.id as BranchId, settings);
      for (const [key, value] of Object.entries(settings)) out.push(`${key === 'levelDb' ? 'level' : key} ${typeof value === 'number' ? r2(value) : String(value)}`);
      const position = num(action.position);
      if (position !== undefined) {
        if (!moveBranch(draft, insertId, slotId, branch.id as BranchId, Math.round(position) - 1)) context.warn('only a parallel rack’s branches can be moved');
        else out.push(`place ${Math.round(position)}`);
      }
      return out.length ? `Branch “${branch.name}” of the ${where}: ${out.join(', ')}` : null;
    },

    rack_effect: (action, context) => {
      const { draft, project } = context;
      const { insertId, slotId, slot } = rackIn(context, action.rack);
      const branch = branchIn(slot.rack, action.branch);
      const position = num(action.position);
      const index = position !== undefined ? Math.round(position) - 1 : undefined;
      if (action.effect !== undefined) {
        const moved = context.effect(action.effect);
        if (!moveRackFx(draft, moved.insertId, moved.slotId, branch.id as BranchId, index ?? branch.fx.length)) fail('that effect is not in this rack, or the branch is full');
        return `Moved the effect to the branch “${branch.name}”`;
      }
      const def = context.plugin(action.plugin, 'effect');
      if (def.id === RACK_PLUGIN_ID) fail('a rack cannot go inside another rack');
      const instance = makePluginInstance(def.id, def.version, defaultValues(def.params));
      const parts = context.settings(instance as never, def, action);
      const added = addRackFx(draft, insertId, slotId, branch.id as BranchId, instance, index === undefined ? {} : { index });
      if (!added) fail(`the branch “${branch.name}” cannot take another effect (at most 8)`);
      const mix = num(action.mix);
      if (mix !== undefined) setFxSlotMix(draft, insertId, added!, mix > 1 && mix <= 100 ? mix / 100 : mix);
      if (bool(action.enabled) === false) setFxSlotEnabled(draft, insertId, added!, false);
      context.remember(action.ref, { kind: 'effect', insertId, slotId: added! });
      return `Added ${def.name} to the branch “${branch.name}” of the rack on ${insertLabel(project, insertId)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    },

    rack_macro: (action, context) => {
      const { draft, services, project } = context;
      const { insertId, slotId, slot } = rackIn(context, action.rack);
      const index = macroIndexIn(slot.rack, action.macro);
      const out: string[] = [];
      const name = str(action.name);
      if (name) {
        renameMacro(draft, insertId, slotId, index, name);
        out.push(`named “${slot.rack.macros[index]?.name}”`);
      }
      const value = num(action.value);
      if (value !== undefined) {
        slot.plugin.params[macroParamId(index)] = clamp01(value);
        out.push(`at ${r2(clamp01(value))}`);
      }
      if (bool(action.clear) === true) {
        clearMacro(draft, insertId, slotId, index);
        out.push('cleared');
      }
      for (const raw of Array.isArray(action.unmap) ? action.unmap : []) {
        if (!isObj(raw)) continue;
        const target = targetOf(context, slot.rack, raw);
        if (!removeMacroMapping(draft, insertId, slotId, index, target)) context.warn('that was not mapped to this macro');
        else out.push(`let go of ${describeMacroTarget(plain(slot.rack) as Rack, target, pluginInfoOf(services)) ?? 'a target'}`);
      }
      for (const raw of Array.isArray(action.map) ? action.map : []) {
        if (!isObj(raw)) continue;
        const rackNow = plain(slot) as FxSlot & { rack: Rack };
        const mapping = mappingOf(context, rackNow, raw, slot.rack);
        if (!setMacroMapping(draft, insertId, slotId, index, mapping)) fail('that macro cannot move any more things');
        out.push(`moves ${describeMacroTarget(rackNow.rack, mapping.target, pluginInfoOf(services)) ?? 'a target'}`);
      }
      if (out.length === 0) return null;
      return `Macro ${index + 1} of the rack on ${insertLabel(project, insertId)}: ${out.join(', ')}`;
    },

    group_into_rack: (action, context) => {
      const { draft, project } = context;
      const insertId = context.insert(action.insert);
      const ids: SlotId[] = [];
      for (const raw of Array.isArray(action.effects) ? action.effects : []) {
        const found = context.effect(raw);
        if (found.insertId !== insertId) fail('the effects must all be on the same track');
        ids.push(found.slotId);
      }
      const result = groupIntoRack(draft, insertId, ids);
      if (!result.ok) return fail(result.reason);
      context.remember(action.ref, { kind: 'effect', insertId, slotId: result.slotId as SlotId });
      return `Put ${ids.length} effect${ids.length === 1 ? '' : 's'} of ${insertLabel(project, insertId)} into a rack`;
    },

    save_rack: (action, context) => {
      const { services, project } = context;
      const { insertId, slot } = rackIn(context, action.rack);
      const name = str(action.name) ?? fail('what should the rack be called?');
      // A plain snapshot: the library keeps it outside the project (and outside this answer's undo step).
      const file = rackSlotToFile(plain(slot) as unknown as FxSlot, name!, str(action.description));
      const saved = services.presets.saveRack(file);
      return `Saved the rack on ${insertLabel(project, insertId)} as “${saved.file.name}”`;
    },
  },
};

/** The branch settings an action carries (name, level, pan, mute, solo). */
function settingsOf(action: Record<string, unknown>) {
  const out: { name?: string; levelDb?: number; pan?: number; muted?: boolean; solo?: boolean } = {};
  const name = str(action.name);
  if (name) out.name = name;
  const level = num(action.level_db);
  if (level !== undefined) out.levelDb = level;
  const pan = num(action.pan);
  if (pan !== undefined) out.pan = pan;
  const mute = bool(action.mute);
  if (mute !== undefined) out.muted = mute;
  const solo = bool(action.solo);
  if (solo !== undefined) out.solo = solo;
  return out;
}
