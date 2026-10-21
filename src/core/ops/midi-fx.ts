/**
 * Draft mutators for a channel's MIDI effects chain (`InstrumentChannel.midiFx`). Call them inside history.transact() or a
 * gesture, like every document edit. Values are checked against the effect's params, so a setting never leaves its range.
 */
import type { Draft } from 'immer';
import type { ParamValue } from '@agstudio/sdk/params';
import { newId } from '../model/ids';
import { targetUsesMidiFx } from '../model/targets';
import type { ChannelId, MidiFxSlot, MidiFxSlotId, Project } from '../model/types';
import { checkedFxValue, defaultFxParams, MAX_MIDI_FX, midiFxDef, slotValues } from '../midi-fx/registry';
import { dropControllers } from './channels';

/** A slot to put in a chain: which effect, and optionally its state and settings (missing settings are the defaults). */
export interface MidiFxSlotPlan {
  effect: string;
  enabled?: boolean;
  params?: Readonly<Record<string, ParamValue>>;
}

function chainOf(d: Draft<Project>, channelId: ChannelId): Draft<MidiFxSlot>[] | undefined {
  const channel = d.channels[channelId];
  return channel?.kind === 'instrument' ? channel.midiFx : undefined;
}

function slotOf(d: Draft<Project>, channelId: ChannelId, slotId: MidiFxSlotId): Draft<MidiFxSlot> | undefined {
  return chainOf(d, channelId)?.find((slot) => slot.id === slotId);
}

/** The settings for a new slot: the defaults, then the given values checked against the effect's params. */
function planParams(effect: string, given: Readonly<Record<string, ParamValue>> | undefined): Record<string, ParamValue> {
  const def = midiFxDef(effect);
  if (!def) return { ...given };
  const params = defaultFxParams(def);
  for (const [id, value] of Object.entries(given ?? {})) {
    const checked = checkedFxValue(def, id, value);
    if (checked !== undefined) params[id] = checked;
  }
  return params;
}

/**
 * Adds an effect to the channel's chain at `index` (the end by default) and returns the new slot's id, or null when the
 * channel is not an instrument, the effect is unknown or the chain already has `MAX_MIDI_FX` effects.
 */
export function addMidiFx(
  d: Draft<Project>,
  channelId: ChannelId,
  effect: string,
  options: { index?: number; id?: MidiFxSlotId; enabled?: boolean; params?: Readonly<Record<string, ParamValue>> } = {},
): MidiFxSlotId | null {
  const channel = d.channels[channelId];
  if (channel?.kind !== 'instrument' || !midiFxDef(effect)) return null;
  if ((channel.midiFx?.length ?? 0) >= MAX_MIDI_FX) return null;
  const slot: MidiFxSlot = {
    id: options.id ?? newId.midiFxSlot(),
    effect,
    enabled: options.enabled ?? true,
    params: planParams(effect, options.params),
  };
  channel.midiFx ??= [];
  const index = options.index === undefined ? channel.midiFx.length : Math.max(0, Math.min(Math.round(options.index), channel.midiFx.length));
  channel.midiFx.splice(index, 0, slot as Draft<MidiFxSlot>);
  return slot.id;
}

/** Takes an effect out of the chain, with the controller links that drove its knobs; the chain field goes when it empties. */
export function removeMidiFx(d: Draft<Project>, channelId: ChannelId, slotId: MidiFxSlotId): void {
  const channel = d.channels[channelId];
  if (channel?.kind !== 'instrument' || !channel.midiFx) return;
  const index = channel.midiFx.findIndex((slot) => slot.id === slotId);
  if (index < 0) return;
  channel.midiFx.splice(index, 1);
  if (channel.midiFx.length === 0) delete channel.midiFx;
  dropControllers(d, (target) => targetUsesMidiFx(target, channelId, slotId));
}

/** Removes every effect of the channel. */
export function clearMidiFx(d: Draft<Project>, channelId: ChannelId): void {
  const channel = d.channels[channelId];
  if (channel?.kind !== 'instrument' || !channel.midiFx) return;
  const removed = channel.midiFx.map((slot) => slot.id);
  delete channel.midiFx;
  dropControllers(d, (target) => removed.some((id) => targetUsesMidiFx(target, channelId, id)));
}

/** Moves an effect to a new place in the chain (the order the notes go through them); it keeps its id and settings. */
export function moveMidiFx(d: Draft<Project>, channelId: ChannelId, slotId: MidiFxSlotId, toIndex: number): void {
  const chain = chainOf(d, channelId);
  if (!chain) return;
  const from = chain.findIndex((slot) => slot.id === slotId);
  if (from < 0) return;
  const to = Math.max(0, Math.min(Math.round(toIndex), chain.length - 1));
  if (to === from) return;
  const [slot] = chain.splice(from, 1);
  if (slot) chain.splice(to, 0, slot);
}

/** Bypasses an effect (false) or turns it back on (true). */
export function setMidiFxEnabled(d: Draft<Project>, channelId: ChannelId, slotId: MidiFxSlotId, enabled: boolean): void {
  const slot = slotOf(d, channelId, slotId);
  if (slot) slot.enabled = enabled;
}

/** Sets one setting of an effect, checked against its param (clamped, rounded or ignored when it is not one of the effect's). */
export function setMidiFxParam(d: Draft<Project>, channelId: ChannelId, slotId: MidiFxSlotId, paramId: string, value: ParamValue): void {
  const slot = slotOf(d, channelId, slotId);
  const def = slot ? midiFxDef(slot.effect) : undefined;
  if (!slot || !def) return;
  const checked = checkedFxValue(def, paramId, value);
  if (checked !== undefined) slot.params[paramId] = checked;
}

/** Sets several settings of an effect at once. */
export function setMidiFxParams(d: Draft<Project>, channelId: ChannelId, slotId: MidiFxSlotId, values: Readonly<Record<string, ParamValue>>): void {
  for (const [id, value] of Object.entries(values)) setMidiFxParam(d, channelId, slotId, id, value);
}

/** Puts every setting of an effect back to its default. */
export function resetMidiFx(d: Draft<Project>, channelId: ChannelId, slotId: MidiFxSlotId): void {
  const slot = slotOf(d, channelId, slotId);
  const def = slot ? midiFxDef(slot.effect) : undefined;
  if (slot && def) slot.params = defaultFxParams(def);
}

/**
 * Replaces the channel's whole chain with new slots (for a saved chain or a chain preset): the old effects and the links that
 * drove them go, the new ones get new ids. Returns the ids in order; effects this version does not know are left out.
 */
export function setMidiFxChain(d: Draft<Project>, channelId: ChannelId, plans: readonly MidiFxSlotPlan[]): MidiFxSlotId[] {
  const channel = d.channels[channelId];
  if (channel?.kind !== 'instrument') return [];
  clearMidiFx(d, channelId);
  const ids: MidiFxSlotId[] = [];
  for (const plan of plans) {
    const id = addMidiFx(d, channelId, plan.effect, {
      ...(plan.enabled !== undefined ? { enabled: plan.enabled } : {}),
      ...(plan.params ? { params: plan.params } : {}),
    });
    if (id) ids.push(id);
  }
  return ids;
}

/** A slot as a plan another channel can be given: the effect, whether it is on, and its settings with defaults filled in. */
export function planOfSlot(slot: MidiFxSlot): MidiFxSlotPlan {
  const def = midiFxDef(slot.effect);
  return { effect: slot.effect, enabled: slot.enabled, params: def ? slotValues(def, slot) : { ...slot.params } };
}
