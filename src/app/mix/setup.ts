/**
 * Setting up a song's mix by role: buses for kick, drums, 808/bass, chords, lead and FX, reverb and
 * delay returns, levels by role, the 808 ducking under the kick, and a master chain ending in a
 * Limiter. It reuses what is there (buses by name, their effects by plugin, the master's Limiter)
 * and takes empty "Insert N" tracks before adding new ones, so running it again changes nothing.
 * The recipe (plugins, presets, params, faders, sends) is in `recipes.ts`.
 */
import type { Draft } from 'immer';
import type { Role } from '@core/arrange/roles';
import { STYLE_LABELS, type Style } from '@core/beat/style';
import { DEFAULT_CHANNEL_VOLUME, makeInsert, makePluginInstance } from '@core/model/defaults';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { newId } from '@core/model/ids';
import {
  MASTER,
  type ChannelId,
  type FxSlot,
  type Insert,
  type InsertId,
  type Project,
  type SlotId,
} from '@core/model/types';
import { setChannelProp } from '@core/ops/channels';
import { addFxSlot, addInsert, moveFxSlot, setInsertProp } from '@core/ops/mixer';
import { setRoute, setSlotSidechain } from '@core/ops/routing';
import { findEmptyInsert } from '@core/query/mixer';
import { defaultValues, type ParamValue } from '@agstudio/sdk';
import { presetChoices, presetValues } from '../presets';
import type { Services } from '../services';
import { BUS_NAMES, bassBusName, busForRole, findMixLayout, type BusRole, type MixLayout } from './layout';
import {
  BUS_ORDER,
  busRecipe,
  EQ_PRO,
  LIMITER,
  MASTER_CHAIN,
  ROLE_VOLUME,
  SWEEP_BANDS,
  type FxRecipe,
} from './recipes';

export interface SetupMixOptions {
  style: Style;
  roles: ReadonlyMap<ChannelId, Role>;
  /** rebuild: a song made in this answer (route everything); fill-gaps: only channels still on the master. */
  mode: 'fill-gaps' | 'rebuild';
  /** Mixer tracks whose faders the AI set itself (left alone). */
  pinned?: ReadonlySet<InsertId>;
  /** Channels whose level the AI set itself (their volume is left alone). */
  pinnedChannels?: ReadonlySet<ChannelId>;
}

export interface SetupMixResult {
  layout: MixLayout;
  /** Change lines for the chat. */
  changes: string[];
}

/** A level in dB as a fader gain (linear), kept under the fader's maximum. */
const faderGainOf = (db: number) => Math.min(MAX_INSERT_VOLUME, Math.pow(10, db / 20));

/** A plugin instance for a recipe: the preset (the musician's own of that name first), then its params. */
export function instanceFor(services: Services, recipe: FxRecipe) {
  const definition = services.plugins.get(recipe.pluginId);
  if (!definition) return null;
  let params: Record<string, ParamValue> = defaultValues(definition.params);
  let state: unknown;
  if (recipe.preset) {
    const presetName = recipe.preset.toLowerCase();
    const preset = presetChoices(definition, services.presets)
      .reverse()
      .find((choice) => choice.name.toLowerCase() === presetName);
    if (preset) ({ params, state } = presetValues(definition, preset));
  }
  for (const [paramId, value] of Object.entries(recipe.params ?? {})) {
    if (definition.params[paramId]) params[paramId] = value;
  }
  return makePluginInstance(
    definition.id,
    definition.version,
    params,
    state !== undefined ? { state: state as never } : {},
  );
}

/** What one setup works on: the draft (also seen as a plain project to read), the services and the options. */
interface SetupContext {
  draft: Draft<Project>;
  project: Project;
  services: Services;
  options: SetupMixOptions;
}

/** The buses the song needs: one per role that plays, plus the returns for what sends to them. */
function busesNeeded({ project, options }: SetupContext): Set<BusRole> {
  const wanted = new Set<BusRole>();
  for (const [channelId, role] of options.roles) {
    const channel = project.channels[channelId];
    if (!channel || channel.kind === 'automation') continue;
    const bus = busForRole(role);
    if (bus) wanted.add(bus);
  }
  if (wanted.has('chords') || wanted.has('lead') || wanted.has('vocals') || wanted.has('fx')) wanted.add('reverb');
  if (wanted.has('lead') || wanted.has('vocals')) wanted.add('delay');
  return wanted;
}

/** The buses found or made, and which of them are new. */
interface ClaimedBuses {
  buses: Partial<Record<BusRole, InsertId>>;
  fresh: Set<BusRole>;
  /** Names of the empty "Insert N" tracks that were taken over. */
  reused: string[];
}

/** The buses: by name if they exist, else the next empty "Insert N", else a new track. */
function claimBuses(context: SetupContext, wanted: ReadonlySet<BusRole>): ClaimedBuses {
  const { draft, project, options } = context;
  const buses: Partial<Record<BusRole, InsertId>> = { ...findMixLayout(project).buses };
  const fresh = new Set<BusRole>();
  const reused: string[] = [];
  for (const role of BUS_ORDER) {
    if (!wanted.has(role) || buses[role]) continue;
    const recipe = busRecipe(role, options.style);
    const name = role === 'bass' ? bassBusName(options.roles.values()) : BUS_NAMES[role];
    let id = findEmptyInsert(project);
    if (id) {
      reused.push(project.mixer.inserts[id]!.name);
      setInsertProp(draft, id, 'name', name);
    } else {
      id = newId.insert();
      addInsert(draft, makeInsert(id, name));
    }
    setInsertProp(draft, id, 'color', recipe.color);
    buses[role] = id;
    fresh.add(role);
  }
  return { buses, fresh, reused };
}

/** The effects a bus lacks (by plugin), in the recipe's order after what is there, wired to their sidechain buses. */
function addBusEffects(context: SetupContext, role: BusRole, insertId: InsertId, buses: ClaimedBuses['buses']): void {
  const { draft, services, options } = context;
  const recipe = busRecipe(role, options.style);
  const insert = draft.mixer.inserts[insertId] as Draft<Insert>;
  for (const effect of recipe.fx) {
    let slot = insert.fx.find((candidate) => candidate.plugin.pluginId === effect.pluginId) as
      Draft<FxSlot> | undefined;
    if (!slot) {
      const instance = instanceFor(services, effect);
      const slotId = instance ? addFxSlot(draft, insertId, instance) : null;
      slot = slotId ? (insert.fx.find((candidate) => candidate.id === slotId) as Draft<FxSlot>) : undefined;
    } else if (effect.pluginId === EQ_PRO && (role === 'chords' || role === 'lead')) {
      // An EQ that is already there (the arranger's, for its filter sweeps) gets its sweep bands.
      Object.assign(slot.plugin.params, SWEEP_BANDS[role]);
    }
    const sidechainBus = effect.sidechain ? buses[effect.sidechain] : undefined;
    if (slot && sidechainBus && slot.sidechain !== sidechainBus) {
      setSlotSidechain(draft, insertId, slot.id as SlotId, sidechainBus);
    }
  }
}

/** Sends from a bus to the returns it should feed (post fader), unless it already routes there. */
function addSendsToReturns(
  context: SetupContext,
  role: BusRole,
  insertId: InsertId,
  buses: ClaimedBuses['buses'],
): void {
  const { draft, options } = context;
  const { sends } = busRecipe(role, options.style);
  for (const [returnRole, db] of Object.entries(sends) as ['reverb' | 'delay', number][]) {
    const returnId = buses[returnRole];
    if (!returnId) continue;
    const hasRoute = draft.mixer.inserts[insertId]!.routes.some((route) => route.to === returnId);
    if (!hasRoute) setRoute(draft, insertId, returnId, { level: faderGainOf(db) });
  }
}

/** Each bus's effects, sends to the returns and fader. */
function dressBuses(context: SetupContext, wanted: ReadonlySet<BusRole>, claimed: ClaimedBuses): void {
  const { draft, options } = context;
  const pinned = options.pinned ?? new Set<InsertId>();
  for (const role of BUS_ORDER) {
    const insertId = claimed.buses[role];
    if (!insertId || !wanted.has(role)) continue;
    addBusEffects(context, role, insertId, claimed.buses);
    addSendsToReturns(context, role, insertId, claimed.buses);
    // Faders: new buses, and every bus of a song built now, except the ones the AI set itself.
    const setsFader = claimed.fresh.has(role) || options.mode === 'rebuild';
    if (setsFader && !pinned.has(insertId)) {
      setInsertProp(draft, insertId, 'volume', faderGainOf(busRecipe(role, options.style).fader));
    }
  }
}

/** The master chain: EQ, tape, Limiter last (an existing Limiter is kept, and moved to the end). Returns what it added. */
function buildMasterChain({ draft, services }: SetupContext): string[] {
  const master = draft.mixer.inserts[MASTER] as Draft<Insert>;
  const added: string[] = [];
  for (const effect of MASTER_CHAIN) {
    if (master.fx.some((slot) => slot.plugin.pluginId === effect.pluginId)) continue;
    const instance = instanceFor(services, effect);
    const limiterAt = master.fx.findIndex((slot) => slot.plugin.pluginId === LIMITER);
    const insertAt = effect.pluginId === LIMITER || limiterAt < 0 ? undefined : limiterAt;
    if (instance && addFxSlot(draft, MASTER, instance, insertAt)) added.push(effect.label);
  }
  const limiters = master.fx.filter((slot) => slot.plugin.pluginId === LIMITER);
  const limiter = limiters[limiters.length - 1];
  if (limiter) {
    if (master.fx[master.fx.length - 1] !== limiter) moveFxSlot(draft, MASTER, limiter.id, master.fx.length - 1);
    limiter.enabled = true;
    limiter.plugin.params.ceiling = -1;
    limiter.plugin.params.truePeak = true;
  }
  return added;
}

/** Channels to their buses: every one of a song built now, else only those still on the master. Returns how many moved. */
function routeChannelsToBuses(context: SetupContext, buses: ClaimedBuses['buses']): number {
  const { draft, options } = context;
  const pinnedChannels = options.pinnedChannels ?? new Set<ChannelId>();
  let routed = 0;
  for (const [channelId, role] of options.roles) {
    const channel = draft.channels[channelId];
    const bus = busForRole(role);
    const busId = bus ? buses[bus] : undefined;
    if (!channel || channel.kind === 'automation' || !busId) continue;
    const isOnMaster = channel.output === MASTER || !draft.mixer.inserts[channel.output];
    if (channel.output === busId || (options.mode === 'fill-gaps' && !isOnMaster)) continue;
    setChannelProp(draft, channelId, 'output', busId);
    routed++;
    // A level by role for channels nobody has set.
    const isUnset = !pinnedChannels.has(channelId) && channel.volume === DEFAULT_CHANNEL_VOLUME;
    if (isUnset && ROLE_VOLUME[role] !== DEFAULT_CHANNEL_VOLUME) {
      setChannelProp(draft, channelId, 'volume', ROLE_VOLUME[role]);
    }
  }
  return routed;
}

/** The chat line for the buses and returns made, or null when none were: "Set up the Trap mix: Kick, Drums buses…". */
function describeNewBuses(context: SetupContext, claimed: ClaimedBuses): string | null {
  const { draft, options } = context;
  const { buses, fresh, reused } = claimed;
  const nameOf = (role: BusRole) =>
    (buses[role] ? draft.mixer.inserts[buses[role]!]?.name : undefined) ?? BUS_NAMES[role];
  const busNames = BUS_ORDER.filter((role) => fresh.has(role) && role !== 'reverb' && role !== 'delay').map(nameOf);
  const returns = (['reverb', 'delay'] as const)
    .filter((role) => fresh.has(role))
    .map((role) => {
      const effect = busRecipe(role, options.style).fx.find((candidate) => candidate.pluginId !== EQ_PRO);
      return `${nameOf(role)} (${effect?.label ?? role})`;
    });
  if (!busNames.length && !returns.length) return null;
  const parts = [
    busNames.length ? `${busNames.join(', ')} bus${busNames.length === 1 ? '' : 'es'}` : '',
    returns.length ? `${returns.join(' and ')} return${returns.length === 1 ? '' : 's'}` : '',
  ];
  const reusedNote = reused.length ? ` (on ${reused.join(', ')})` : '';
  return `Set up the ${STYLE_LABELS[options.style]} mix: ${parts.filter(Boolean).join(', ')}${reusedNote}`;
}

/**
 * Builds (or completes) the role mix in a draft. Returns the layout it ended with and what it did,
 * in a few lines for the chat.
 */
export function setupMix(draft: Draft<Project>, services: Services, options: SetupMixOptions): SetupMixResult {
  const project = draft as unknown as Project;
  const context: SetupContext = { draft, project, services, options };
  const changes: string[] = [];
  const wanted = busesNeeded(context);
  if (!wanted.size) return { layout: findMixLayout(project), changes };

  const claimed = claimBuses(context, wanted);
  dressBuses(context, wanted, claimed);
  const masterAdditions = buildMasterChain(context);
  const routedCount = routeChannelsToBuses(context, claimed.buses);

  const busesLine = describeNewBuses(context, claimed);
  if (busesLine) changes.push(busesLine);
  if (routedCount) changes.push(`Routed ${routedCount} channel${routedCount === 1 ? '' : 's'} to their buses`);
  if (masterAdditions.length) changes.push(`Master: ${masterAdditions.join(', ')}`);
  return { layout: findMixLayout(project), changes };
}
