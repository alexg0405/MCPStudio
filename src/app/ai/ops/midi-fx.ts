/**
 * MIDI effects actions: `add_midi_effect`, `edit_midi_effect` and `remove_midi_effect` change an instrument channel's chain
 * (an arpeggiator, chords, scale, echo… that change the notes on their way to the instrument), `midi_effects_chain` puts a
 * ready-made or saved chain on a channel, and `render_midi_effects` writes what the chain makes into the patterns as notes.
 * They use the same operations and the same planning code as the MIDI effects window.
 */
import { current } from 'immer';
import { formatValue, type ParamSpec, type ParamSpecs } from '@agstudio/sdk';
import { defaultFxParams, MAX_MIDI_FX, MIDI_FX, midiFxDef } from '@core/midi-fx/registry';
import type { MidiFxDef } from '@core/midi-fx/types';
import type { ChannelId, MidiFxSlot, MidiFxSlotId, Project } from '@core/model/types';
import {
  addMidiFx,
  clearMidiFx,
  moveMidiFx,
  removeMidiFx,
  setMidiFxChain,
  setMidiFxEnabled,
  setMidiFxParams,
} from '@core/ops/midi-fx';
import { hasActiveMidiFx, midiFxOf } from '@core/query/midi-fx';
import { FACTORY_CHAINS, findMidiFxChain, fxPresetKey } from '../../actions/midi-fx';
import { MAX_BAKED_NOTES, planBake, writeBake } from '../../actions/midi-fx-bake';
import * as S from '../schema/parts';
import { fail, type OpContext, type OpModule } from './context';
import { bool, coerceParam, findParamId, isObj, lower, num, str } from './values';

const EFFECT_IDS = MIDI_FX.map((def) => def.id);

/** The channel's name, for change lines. */
const nameOf = (context: OpContext, channelId: ChannelId): string => context.draft.channels[channelId]?.name ?? channelId;

/** An instrument channel by the usual lookups; a channel that plays audio has no MIDI effects. */
function instrumentChannel(context: OpContext, raw: unknown): ChannelId {
  const channelId = context.channel(raw);
  if (context.draft.channels[channelId]?.kind !== 'instrument') fail(`“${nameOf(context, channelId)}” plays audio, not notes, so it has no MIDI effects`);
  return channelId;
}

/** The effect definition for an id or name from the catalog ("arp", "Arpeggiator"). */
function effectDef(raw: unknown): MidiFxDef {
  const wanted = lower(str(raw) ?? fail('which MIDI effect? (ids: ' + EFFECT_IDS.join(', ') + ')'));
  return MIDI_FX.find((def) => def.id === wanted || lower(def.name) === wanted) ?? fail(`there is no MIDI effect "${wanted}" (ids: ${EFFECT_IDS.join(', ')})`);
}

/**
 * One effect of a channel's chain: by @ref (made earlier in this answer), by id (mfx_…), by its 1-based place in the chain, or by
 * the effect's name when the chain has only one of that kind.
 */
export function resolveMidiFxSlot(context: OpContext, channelId: ChannelId, raw: unknown): MidiFxSlot {
  const ref = str(raw) ?? (typeof raw === 'number' ? String(raw) : fail('which MIDI effect? (its id, its number in the chain, or its name)'));
  const chain = midiFxOf(context.draft.channels[channelId] as never);
  if (ref.startsWith('@')) {
    const made = context.state.refs.get(lower(ref));
    const slot = made?.kind === 'midiFx' && made.channelId === channelId ? chain.find((candidate) => candidate.id === made.slotId) : undefined;
    return slot ?? fail(`nothing called ${ref} was made on ${nameOf(context, channelId)} earlier in this answer`);
  }
  const byId = chain.find((candidate) => candidate.id === ref);
  if (byId) return byId;
  if (/^\d+$/.test(ref)) return chain[Number(ref) - 1] ?? fail(`${nameOf(context, channelId)} has ${chain.length} MIDI effect${chain.length === 1 ? '' : 's'}, not ${ref}`);
  const wanted = lower(ref);
  const named = chain.filter((candidate) => candidate.effect === wanted || lower(midiFxDef(candidate.effect)?.name ?? '') === wanted);
  if (named.length === 1) return named[0] as MidiFxSlot;
  if (named.length > 1) fail(`${nameOf(context, channelId)} has ${named.length} “${ref}” effects: give the number of the one you mean`);
  return fail(`${nameOf(context, channelId)} has no MIDI effect "${ref}"`);
}

/** The preset and settings an action names, applied to a slot; returns what changed for the change line. */
function applySettings(context: OpContext, channelId: ChannelId, slotId: MidiFxSlotId, def: MidiFxDef, action: Record<string, unknown>): string[] {
  const out: string[] = [];
  const presetName = str(action.preset);
  if (presetName) {
    // The musician's own presets first (they name them), then the effect's own.
    const mine = context.services.presets.forPlugin(fxPresetKey(def.id)).find((preset) => lower(preset.name) === lower(presetName));
    const ready = def.presets.find((preset) => lower(preset.name) === lower(presetName));
    const params = mine?.params ?? ready?.params;
    if (!params) context.warn(`${def.name} has no preset "${presetName}"`);
    else {
      // A preset is a complete setting: what it does not name goes back to the default.
      setMidiFxParams(context.draft, channelId, slotId, { ...defaultFxParams(def), ...params });
      out.push(`preset ${mine?.name ?? ready?.name}`);
    }
  }
  if (Array.isArray(action.params)) {
    for (const entry of action.params) {
      if (!isObj(entry) || typeof entry.name !== 'string') continue;
      const id = findParamId(def.params as ParamSpecs, entry.name);
      if (!id) {
        context.warn(`${def.name} has no setting "${entry.name}"`);
        continue;
      }
      const spec = def.params[id] as ParamSpec;
      const value = coerceParam(spec, entry.value);
      if (value === null) {
        context.warn(`${def.name} ${id}: can't use ${JSON.stringify(entry.value)}`);
        continue;
      }
      setMidiFxParams(context.draft, channelId, slotId, { [id]: value });
      out.push(`${spec.label ?? id} ${formatValue(spec, value)}`);
    }
  }
  return out;
}

/** The effects of a chain by name, for change lines ("Arpeggiator, Chord"). */
const chainNames = (chain: readonly MidiFxSlot[]) => chain.map((slot) => midiFxDef(slot.effect)?.name ?? slot.effect).join(', ');

function addEffect(action: Record<string, unknown>, context: OpContext): string {
  const channelId = instrumentChannel(context, action.channel);
  const def = effectDef(action.effect);
  const position = num(action.position);
  const slotId = addMidiFx(context.draft, channelId, def.id, position !== undefined ? { index: position - 1 } : {});
  if (!slotId) fail(`${nameOf(context, channelId)} already has ${MAX_MIDI_FX} MIDI effects`);
  const made = slotId as MidiFxSlotId;
  const parts = applySettings(context, channelId, made, def, action);
  if (bool(action.enabled) === false) setMidiFxEnabled(context.draft, channelId, made, false);
  context.remember(action.ref, { kind: 'midiFx', channelId, slotId: made });
  return `Added ${def.name} to ${nameOf(context, channelId)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

function editEffect(action: Record<string, unknown>, context: OpContext): string | null {
  const channelId = instrumentChannel(context, action.channel);
  const slot = resolveMidiFxSlot(context, channelId, action.effect);
  const def = midiFxDef(slot.effect) ?? fail(`this version has no MIDI effect "${slot.effect}"`);
  const out = applySettings(context, channelId, slot.id, def, action);
  const enabled = bool(action.enabled);
  if (enabled !== undefined) {
    setMidiFxEnabled(context.draft, channelId, slot.id, enabled);
    out.push(enabled ? 'on' : 'bypassed');
  }
  const position = num(action.position);
  if (position !== undefined) {
    moveMidiFx(context.draft, channelId, slot.id, position - 1);
    out.push(`place ${Math.round(position)}`);
  }
  return out.length ? `${def.name} on ${nameOf(context, channelId)}: ${out.join(', ')}` : null;
}

function removeEffect(action: Record<string, unknown>, context: OpContext): string {
  const channelId = instrumentChannel(context, action.channel);
  if (lower(str(action.effect) ?? '') === 'all') {
    const count = midiFxOf(context.draft.channels[channelId] as never).length;
    if (count === 0) fail(`${nameOf(context, channelId)} has no MIDI effects`);
    clearMidiFx(context.draft, channelId);
    return `Removed all ${count} MIDI effect${count === 1 ? '' : 's'} from ${nameOf(context, channelId)}`;
  }
  const slot = resolveMidiFxSlot(context, channelId, action.effect);
  const name = midiFxDef(slot.effect)?.name ?? slot.effect;
  removeMidiFx(context.draft, channelId, slot.id);
  return `Removed ${name} from ${nameOf(context, channelId)}`;
}

function loadChain(action: Record<string, unknown>, context: OpContext): string {
  const channelId = instrumentChannel(context, action.channel);
  const name = str(action.chain) ?? fail('which chain? (the catalog lists the ready-made ones)');
  const chain = findMidiFxChain(context.services, name) ?? fail(`there is no MIDI effects chain "${name}" (the catalog lists them)`);
  if (chain.slots.length === 0) fail(`“${chain.name}” has no effects this version knows`);
  const append = lower(str(action.mode) ?? 'replace') === 'append';
  if (append) {
    for (const plan of chain.slots) addMidiFx(context.draft, channelId, plan.effect, { ...(plan.enabled !== undefined ? { enabled: plan.enabled } : {}), ...(plan.params ? { params: plan.params } : {}) });
  } else {
    setMidiFxChain(context.draft, channelId, chain.slots);
  }
  const made = midiFxOf(context.draft.channels[channelId] as never);
  return `${nameOf(context, channelId)} now has the “${chain.name}” chain (${chainNames(made)})`;
}

function renderEffects(action: Record<string, unknown>, context: OpContext): string {
  const channelId = instrumentChannel(context, action.channel);
  const project = current(context.draft) as unknown as Project;
  if (!hasActiveMidiFx(project.channels[channelId])) fail(`${nameOf(context, channelId)} has no MIDI effects that change its notes (bypassed ones do nothing)`);
  const plan = planBake(project, channelId);
  if (!plan || plan.patterns.length === 0) fail(`${nameOf(context, channelId)} has no notes in any pattern, so there is nothing to render`);
  const baked = plan!;
  if (baked.after > MAX_BAKED_NOTES) fail(`the effects would make ${baked.after} notes, more than the ${MAX_BAKED_NOTES} one render may write`);
  // The chain applies to every pattern of the channel, so a part-only focus cannot allow it.
  context.focus.span(0, Number.POSITIVE_INFINITY, 'render the MIDI effects to notes');
  for (const { patternId } of baked.patterns) context.focus.wholePattern(patternId, channelId, 'render the MIDI effects to notes');
  writeBake(context.draft, channelId, baked, { keepEffects: bool(action.keep_effects) === true });
  return `Rendered the MIDI effects of ${nameOf(context, channelId)} into ${baked.after} notes in ${baked.patterns.length} pattern${baked.patterns.length === 1 ? '' : 's'}`;
}

export const midiFx: OpModule = {
  schemas: [
    S.op(
      'add_midi_effect',
      'Adds a MIDI effect to an instrument channel: it changes the notes on their way to the instrument, for the song and for live keys (effects are listed in the catalog). Effects run in order, first to last.',
      {
        channel: S.CHANNEL,
        effect: { type: 'string', enum: EFFECT_IDS, description: 'The effect id from the catalog.' },
        preset: S.str('A preset name from the catalog for this effect (applied before params).'),
        params: { ...S.PARAMS, description: 'Effect settings: name = param id from the catalog; value in the unit listed there (params marked 0–1 % take 0–1, enums take an option id, on/off params take true/false).' },
        position: S.int('1-based place in the chain (default: last).'),
        enabled: S.bool('False adds it bypassed.'),
        ref: S.REF,
      },
      ['channel', 'effect'],
    ),
    S.op(
      'edit_midi_effect',
      'Changes an effect in a channel’s MIDI effects chain: its settings, bypass or place.',
      {
        channel: S.CHANNEL,
        effect: S.str('The effect: its id (mfx_…), @ref of one added earlier, its 1-based number in the chain, or its name when the chain has one of that kind.'),
        preset: S.str('A preset name from the catalog for this effect (applied before params).'),
        params: S.PARAMS,
        enabled: S.bool('True turns it on, false bypasses it.'),
        position: S.int('Move it to this 1-based place in the chain.'),
      },
      ['channel', 'effect'],
    ),
    S.op(
      'remove_midi_effect',
      'Takes a MIDI effect off a channel, or all of them.',
      {
        channel: S.CHANNEL,
        effect: S.str('The effect (id mfx_…, @ref, 1-based number in the chain, or name), or "all".'),
      },
      ['channel', 'effect'],
    ),
    S.op(
      'midi_effects_chain',
      `Puts a ready-made or saved chain of MIDI effects on a channel (ready-made: ${FACTORY_CHAINS.map((chain) => `“${chain.name}”`).join(', ')}; the catalog lists the musician's own too).`,
      {
        channel: S.CHANNEL,
        chain: S.str('The chain’s name.'),
        mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) swaps the channel’s effects; append adds the chain after them.' },
      },
      ['channel', 'chain'],
    ),
    S.op(
      'render_midi_effects',
      'Writes what a channel’s MIDI effects make into all its patterns as ordinary notes (the notes that play now, as heard in a pattern on its own) and takes the effects off the channel, so the part can be edited by hand. Use only when asked to bake, commit or render the effects.',
      {
        channel: S.CHANNEL,
        keep_effects: S.bool('Keep the effects on the channel but bypassed, instead of removing them.'),
      },
      ['channel'],
    ),
  ],
  prompt: {
    id: 'midi-fx',
    order: 33,
    text: 'MIDI effects: add_midi_effect puts an arpeggiator, chord, scale, note repeat, echo, humanize, velocity, transpose, note length or random effect on an instrument channel (settings in the catalog; they change the notes before the instrument, in the song and for live keys, and never touch the notes in the patterns); edit_midi_effect changes settings, bypass or order; remove_midi_effect removes; midi_effects_chain loads a named chain; render_midi_effects writes the result into the pattern notes. An arpeggio is added to a channel that holds a chord, not to one that plays single notes.',
  },
  handlers: {
    add_midi_effect: addEffect,
    edit_midi_effect: editEffect,
    remove_midi_effect: removeEffect,
    midi_effects_chain: loadChain,
    render_midi_effects: renderEffects,
  },
};

