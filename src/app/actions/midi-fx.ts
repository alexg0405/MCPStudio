/**
 * A channel's MIDI effects as user actions: add, remove, reorder and bypass effects, load presets and saved chains, and render
 * the effects into the notes. Each is one undo step; the window, the menus, the action search and Studio all come through here.
 */
import type { ChannelId, MidiFxSlotId } from '@core/model/types';
import { midiFxDef, MIDI_FX, MAX_MIDI_FX, slotValues } from '@core/midi-fx/registry';
import type { FxPreset } from '@core/midi-fx/types';
import {
  addMidiFx,
  clearMidiFx,
  moveMidiFx,
  planOfSlot,
  removeMidiFx,
  setMidiFxChain,
  setMidiFxEnabled,
  setMidiFxParams,
  type MidiFxSlotPlan,
} from '@core/ops/midi-fx';
import { hasActiveMidiFx, midiFxOf } from '@core/query/midi-fx';
import type { ParamValue } from '@agstudio/sdk/params';
import type { JsonValue } from '@agstudio/sdk';
import type { Services } from '../services';
import { MAX_BAKED_NOTES, planBake, writeBake } from './midi-fx-bake';

/** What an action did, for a toast or Studio's change line. */
export interface MidiFxResult {
  ok: boolean;
  message: string;
}

/** The effect's name for messages. */
function nameOf(effect: string): string {
  return midiFxDef(effect)?.name ?? effect;
}

/** The channel's name and whether it can have MIDI effects (instrument channels only), or the reason it cannot. */
function channelFor(s: Services, channelId: ChannelId): { name: string } | string {
  const channel = s.doc.getState().project.channels[channelId];
  if (!channel) return 'That channel no longer exists.';
  if (channel.kind !== 'instrument') return `“${channel.name}” plays audio, not notes, so it has no MIDI effects.`;
  return { name: channel.name };
}

/** Adds an effect to the end of the channel's chain (or at `index`), optionally with a preset's settings; returns the new slot. */
export function addMidiEffect(
  s: Services,
  channelId: ChannelId,
  effect: string,
  options: { index?: number; params?: Readonly<Record<string, ParamValue>> } = {},
): MidiFxSlotId | null {
  const def = midiFxDef(effect);
  if (!def || typeof channelFor(s, channelId) === 'string') return null;
  if (midiFxOf(s.doc.getState().project.channels[channelId]).length >= MAX_MIDI_FX) {
    s.session.getState().toast(`A channel can have up to ${MAX_MIDI_FX} MIDI effects.`, 'info');
    return null;
  }
  let id: MidiFxSlotId | null = null;
  s.history.transact(`Add ${def.name}`, (d) => {
    id = addMidiFx(d, channelId, effect, {
      ...(options.index !== undefined ? { index: options.index } : {}),
      ...(options.params ? { params: options.params } : {}),
    });
  });
  return id;
}

/** Takes an effect out of the chain. */
export function removeMidiEffect(s: Services, channelId: ChannelId, slotId: MidiFxSlotId): void {
  const slot = midiFxOf(s.doc.getState().project.channels[channelId]).find((x) => x.id === slotId);
  if (!slot) return;
  s.history.transact(`Remove ${nameOf(slot.effect)}`, (d) => removeMidiFx(d, channelId, slotId));
}

/** Removes every effect of the channel. */
export function clearMidiEffects(s: Services, channelId: ChannelId): void {
  if (midiFxOf(s.doc.getState().project.channels[channelId]).length === 0) return;
  s.history.transact('Remove MIDI effects', (d) => clearMidiFx(d, channelId));
}

/** Moves an effect one place earlier (-1) or later (+1) in the chain. */
export function moveMidiEffectBy(s: Services, channelId: ChannelId, slotId: MidiFxSlotId, delta: number): void {
  const chain = midiFxOf(s.doc.getState().project.channels[channelId]);
  const from = chain.findIndex((x) => x.id === slotId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= chain.length) return;
  moveMidiEffectTo(s, channelId, slotId, to);
}

/** Moves an effect to a place in the chain (a drag in the window). */
export function moveMidiEffectTo(s: Services, channelId: ChannelId, slotId: MidiFxSlotId, index: number): void {
  const slot = midiFxOf(s.doc.getState().project.channels[channelId]).find((x) => x.id === slotId);
  if (!slot) return;
  s.history.transact(`Move ${nameOf(slot.effect)}`, (d) => moveMidiFx(d, channelId, slotId, index));
}

/** Bypasses an effect or turns it back on. */
export function toggleMidiEffect(s: Services, channelId: ChannelId, slotId: MidiFxSlotId): void {
  const slot = midiFxOf(s.doc.getState().project.channels[channelId]).find((x) => x.id === slotId);
  if (!slot) return;
  s.history.transact(`${slot.enabled ? 'Bypass' : 'Enable'} ${nameOf(slot.effect)}`, (d) => setMidiFxEnabled(d, channelId, slotId, !slot.enabled));
}

/** Bypasses every effect of the chain (when any is on) or turns them all back on: A/B-ing a whole chain in one undo step. */
export function toggleAllMidiEffects(s: Services, channelId: ChannelId): void {
  const chain = midiFxOf(s.doc.getState().project.channels[channelId]);
  if (chain.length === 0) return;
  const anyOn = chain.some((slot) => slot.enabled);
  s.history.transact(anyOn ? 'Bypass MIDI effects' : 'Turn MIDI effects on', (d) => {
    for (const slot of chain) setMidiFxEnabled(d, channelId, slot.id, !anyOn);
  });
}

/** Gives an effect the settings of a preset (the ones the preset names; the rest stay). */
export function applyMidiFxPreset(s: Services, channelId: ChannelId, slotId: MidiFxSlotId, preset: FxPreset): void {
  const slot = midiFxOf(s.doc.getState().project.channels[channelId]).find((x) => x.id === slotId);
  const def = slot ? midiFxDef(slot.effect) : undefined;
  if (!slot || !def) return;
  // A preset is a complete setting: what it does not name goes back to the effect's default.
  const defaults = Object.fromEntries(Object.entries(def.params).map(([id, spec]) => [id, spec.default]));
  s.history.transact(`${def.name}: ${preset.name}`, (d) => setMidiFxParams(d, channelId, slotId, { ...defaults, ...preset.params }));
}

// ---- Your presets and chains (kept with the other presets: see app/presets.ts) ----

/** The id your presets of an effect are kept under in the preset library. */
export const fxPresetKey = (effect: string): string => `midifx:${effect}`;
/** The id your saved chains are kept under in the preset library (the chain itself is in the preset's `state`). */
export const FX_CHAIN_KEY = 'midifx:chain';

/** Saves the effect's current settings as one of your presets. */
export function saveMidiFxPreset(s: Services, channelId: ChannelId, slotId: MidiFxSlotId, name: string): MidiFxResult {
  const slot = midiFxOf(s.doc.getState().project.channels[channelId]).find((x) => x.id === slotId);
  const def = slot ? midiFxDef(slot.effect) : undefined;
  if (!slot || !def) return { ok: false, message: 'That effect no longer exists.' };
  const saved = s.presets.save({ pluginId: fxPresetKey(slot.effect), version: 1, name, params: slotValues(def, slot) });
  return { ok: true, message: `Saved “${saved.name}” as your ${def.name} preset.` };
}

/** One saved chain's slots as they were stored (checked: unknown effects stay out). */
function savedChainSlots(state: JsonValue | undefined): MidiFxSlotPlan[] {
  const raw = (state as { slots?: unknown } | undefined)?.slots;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): MidiFxSlotPlan[] => {
    const slot = entry as { effect?: unknown; enabled?: unknown; params?: unknown };
    if (typeof slot.effect !== 'string' || !midiFxDef(slot.effect)) return [];
    const params = typeof slot.params === 'object' && slot.params !== null ? (slot.params as Record<string, ParamValue>) : {};
    return [{ effect: slot.effect, enabled: slot.enabled !== false, params }];
  });
}

/** Your saved chains, by name. */
export function savedMidiFxChains(s: Services): { id: string; name: string; slots: MidiFxSlotPlan[] }[] {
  return s.presets.forPlugin(FX_CHAIN_KEY).map((preset) => ({ id: preset.id, name: preset.name, slots: savedChainSlots(preset.state) }));
}

/** Saves the channel's whole chain under a name (a chain of the same name is replaced). */
export function saveMidiFxChain(s: Services, channelId: ChannelId, name: string): MidiFxResult {
  const chain = midiFxOf(s.doc.getState().project.channels[channelId]);
  if (chain.length === 0) return { ok: false, message: 'Add some MIDI effects first: there is no chain to save.' };
  const slots = chain.map(planOfSlot);
  const saved = s.presets.save({ pluginId: FX_CHAIN_KEY, version: 1, name, params: {}, state: { slots } as unknown as JsonValue });
  return { ok: true, message: `Saved the chain (${chain.map((x) => nameOf(x.effect)).join(', ')}) as “${saved.name}”.` };
}

/** Ready-made chains that ship with the app: a name, what it is for and its effects with their settings. */
export interface FactoryChain {
  name: string;
  description: string;
  slots: readonly MidiFxSlotPlan[];
}

/** The chains offered next to your own. */
export const FACTORY_CHAINS: readonly FactoryChain[] = [
  {
    name: 'Pluck arp',
    description: 'A bright 1/16 arpeggio over two octaves, a little humanized.',
    slots: [
      { effect: 'arp', params: { pattern: 'up', rate: '1/16', octaves: 2, gate: 0.6 } },
      { effect: 'humanize', params: { timing: 6, velocity: 0.08 } },
    ],
  },
  {
    name: 'Chords in the song key',
    description: 'Every note you play becomes a chord of the song key (set the key in the toolbar).',
    slots: [{ effect: 'chord', params: { source: 'scale', size: 3 } }, { effect: 'scale', params: { source: 'song' } }],
  },
  {
    name: 'Trance gate',
    description: 'Held chords chopped into a pumping 1/16 pattern with accents.',
    slots: [{ effect: 'arp', params: { pattern: 'chord', rate: '1/16', gate: 0.5, velocity: 'accent', accentEvery: 4, accentDepth: 0.4 } }],
  },
  {
    name: 'Dub echo',
    description: 'Each note repeats as dotted-eighth echoes that fade away.',
    slots: [{ effect: 'echo', params: { delay: '1/8.', repeats: 5, feedback: 0.6 } }],
  },
  {
    name: 'Stay in key and tidy',
    description: 'Snaps every note into the song key and evens out the loudness.',
    slots: [{ effect: 'scale', params: { source: 'song' } }, { effect: 'velocity', params: { curve: -0.5 } }],
  },
];

/** Replaces the channel's chain with a list of effects (a saved chain, a factory chain), one undo step. */
export function loadMidiFxChain(s: Services, channelId: ChannelId, name: string, slots: readonly MidiFxSlotPlan[]): MidiFxResult {
  const problem = channelFor(s, channelId);
  if (typeof problem === 'string') return { ok: false, message: problem };
  if (slots.length === 0) return { ok: false, message: `“${name}” has no effects this version knows.` };
  s.history.transact(`MIDI effects: ${name}`, (d) => void setMidiFxChain(d, channelId, slots));
  return { ok: true, message: `${problem.name} now has the “${name}” chain.` };
}

/** The chain with this name: one of yours, else a factory chain (names compare without caring about case). */
export function findMidiFxChain(s: Services, name: string): { name: string; slots: readonly MidiFxSlotPlan[] } | null {
  const same = (a: string) => a.trim().toLowerCase() === name.trim().toLowerCase();
  const mine = savedMidiFxChains(s).find((chain) => same(chain.name));
  if (mine) return mine;
  return FACTORY_CHAINS.find((chain) => same(chain.name)) ?? null;
}

// ---- Render to notes ----

/** Options of `bakeMidiEffects`. */
export interface BakeOptions {
  /** Keep the effects in the chain but bypassed (the default removes them, because they have been written into the notes). */
  keepEffects?: boolean;
}

/**
 * Writes what the channel's MIDI effects make into its patterns as notes and takes the effects out of the way, as one undo
 * step. Every pattern that has notes for the channel is rendered, because the chain applies to all of them. The effects read the
 * song key and the chord track as a pattern played on its own sees them.
 */
export function bakeMidiEffects(s: Services, channelId: ChannelId, options: BakeOptions = {}): MidiFxResult {
  const problem = channelFor(s, channelId);
  if (typeof problem === 'string') return { ok: false, message: problem };
  const project = s.doc.getState().project;
  if (!hasActiveMidiFx(project.channels[channelId])) {
    return { ok: false, message: `${problem.name} has no MIDI effects that change its notes (bypassed ones do nothing), so there is nothing to render.` };
  }
  const plan = planBake(project, channelId);
  if (!plan || plan.patterns.length === 0) {
    return { ok: false, message: `${problem.name} has no notes in any pattern, so there is nothing to render.` };
  }
  if (plan.after > MAX_BAKED_NOTES) {
    return { ok: false, message: `The effects would make ${plan.after} notes, more than the ${MAX_BAKED_NOTES} one render may write: lower the rate or shorten the part.` };
  }
  s.history.transact('Render MIDI effects to notes', (d) => writeBake(d, channelId, plan, options));
  const where = plan.patterns.length === 1 ? `pattern “${plan.patterns[0]!.name}”` : `${plan.patterns.length} patterns`;
  return { ok: true, message: `Wrote ${plan.after} notes into ${where} of ${problem.name} (${plan.before} before) and ${options.keepEffects ? 'bypassed' : 'removed'} the MIDI effects.` };
}

/** Every effect, for the "add" menu: id, name and what it does. */
export const MIDI_EFFECT_CHOICES: readonly { id: string; name: string; description: string }[] = MIDI_FX.map((def) => ({ id: def.id, name: def.name, description: def.description }));
