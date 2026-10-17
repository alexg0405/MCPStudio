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
import { MASTER, type ChannelId, type FxSlot, type Insert, type InsertId, type Project, type SlotId } from '@core/model/types';
import { setChannelProp } from '@core/ops/channels';
import { addFxSlot, addInsert, moveFxSlot, setInsertProp } from '@core/ops/mixer';
import { setRoute, setSlotSidechain } from '@core/ops/routing';
import { findEmptyInsert } from '@core/query/mixer';
import { defaultValues, type ParamValue } from '@agstudio/sdk';
import { presetChoices, presetValues } from '../presets';
import type { Services } from '../services';
import { BUS_NAMES, busForRole, findMixLayout, type BusRole, type MixLayout } from './layout';
import { BUS_ORDER, busRecipe, EQ_PRO, LIMITER, MASTER_CHAIN, ROLE_VOLUME, SWEEP_BANDS, type FxRecipe } from './recipes';

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

const gainOf = (db: number) => Math.min(MAX_INSERT_VOLUME, Math.pow(10, db / 20));

/** A plugin instance for a recipe: the preset (the musician's own of that name first), then its params. */
export function instanceFor(s: Services, fx: FxRecipe) {
  const def = s.plugins.get(fx.pluginId);
  if (!def) return null;
  let params: Record<string, ParamValue> = defaultValues(def.params);
  let state: unknown;
  if (fx.preset) {
    const preset = presetChoices(def, s.presets)
      .reverse()
      .find((x) => x.name.toLowerCase() === fx.preset!.toLowerCase());
    if (preset) ({ params, state } = presetValues(def, preset));
  }
  for (const [k, v] of Object.entries(fx.params ?? {})) if (def.params[k]) params[k] = v;
  return makePluginInstance(def.id, def.version, params, state !== undefined ? { state: state as never } : {});
}

/**
 * Builds (or completes) the role mix in a draft. Returns the layout it ended with and what it did,
 * in a few lines for the chat.
 */
export function setupMix(d: Draft<Project>, s: Services, opts: SetupMixOptions): SetupMixResult {
  const p = d as unknown as Project;
  const { style, mode } = opts;
  const pinned = opts.pinned ?? new Set<InsertId>();
  const pinnedChannels = opts.pinnedChannels ?? new Set<ChannelId>();
  const changes: string[] = [];

  // Which buses the song needs: one per role that plays, the returns for what sends to them.
  const wanted = new Set<BusRole>();
  for (const [cid, role] of opts.roles) {
    const ch = p.channels[cid];
    if (!ch || ch.kind === 'automation') continue;
    const bus = busForRole(role);
    if (bus) wanted.add(bus);
  }
  if (wanted.has('chords') || wanted.has('lead') || wanted.has('vocals') || wanted.has('fx')) wanted.add('reverb');
  if (wanted.has('lead') || wanted.has('vocals')) wanted.add('delay');
  if (!wanted.size) return { layout: findMixLayout(p), changes };

  // The buses: by name if they exist, else the next empty "Insert N", else a new track.
  const existing = findMixLayout(p);
  const buses: Partial<Record<BusRole, InsertId>> = { ...existing.buses };
  const fresh = new Set<BusRole>();
  const reused: string[] = [];
  for (const role of BUS_ORDER) {
    if (!wanted.has(role) || buses[role]) continue;
    const recipe = busRecipe(role, style);
    let id = findEmptyInsert(p);
    if (id) {
      reused.push(p.mixer.inserts[id]!.name);
      setInsertProp(d, id, 'name', BUS_NAMES[role]);
    } else {
      id = newId.insert();
      addInsert(d, makeInsert(id, BUS_NAMES[role]));
    }
    setInsertProp(d, id, 'color', recipe.color);
    buses[role] = id;
    fresh.add(role);
  }

  // Each bus's effects: the ones it lacks (by plugin), in the recipe's order after what is there.
  for (const role of BUS_ORDER) {
    const id = buses[role];
    if (!id || !wanted.has(role)) continue;
    const recipe = busRecipe(role, style);
    const ins = d.mixer.inserts[id] as Draft<Insert>;
    for (const fx of recipe.fx) {
      let slot = ins.fx.find((f) => f.plugin.pluginId === fx.pluginId) as Draft<FxSlot> | undefined;
      if (!slot) {
        const inst = instanceFor(s, fx);
        const slotId = inst ? addFxSlot(d, id, inst) : null;
        slot = slotId ? (ins.fx.find((f) => f.id === slotId) as Draft<FxSlot>) : undefined;
      } else if (fx.pluginId === EQ_PRO && (role === 'chords' || role === 'lead')) {
        // An EQ that is already there (the arranger's, for its filter sweeps) gets its sweep bands.
        Object.assign(slot.plugin.params, SWEEP_BANDS[role]);
      }
      if (slot && fx.sidechain && buses[fx.sidechain] && slot.sidechain !== buses[fx.sidechain])
        setSlotSidechain(d, id, slot.id as SlotId, buses[fx.sidechain]!);
    }
    // Sends to the returns (post fader).
    for (const [to, db] of Object.entries(recipe.sends) as ['reverb' | 'delay', number][]) {
      const target = buses[to];
      if (target && !d.mixer.inserts[id]!.routes.some((r) => r.to === target)) setRoute(d, id, target, { level: gainOf(db) });
    }
    // Faders: new buses, and every bus of a song built now, except the ones the AI set itself.
    if ((fresh.has(role) || mode === 'rebuild') && !pinned.has(id)) setInsertProp(d, id, 'volume', gainOf(recipe.fader));
  }

  // The master chain: EQ, tape, Limiter last (an existing Limiter is kept, and moved to the end).
  const master = d.mixer.inserts[MASTER] as Draft<Insert>;
  const added: string[] = [];
  for (const fx of MASTER_CHAIN) {
    if (master.fx.some((f) => f.plugin.pluginId === fx.pluginId)) continue;
    const inst = instanceFor(s, fx);
    const limiterAt = master.fx.findIndex((f) => f.plugin.pluginId === LIMITER);
    if (inst && addFxSlot(d, MASTER, inst, fx.pluginId === LIMITER || limiterAt < 0 ? undefined : limiterAt)) added.push(fx.label);
  }
  const limiters = master.fx.filter((f) => f.plugin.pluginId === LIMITER);
  const limiter = limiters[limiters.length - 1];
  if (limiter) {
    if (master.fx[master.fx.length - 1] !== limiter) moveFxSlot(d, MASTER, limiter.id, master.fx.length - 1);
    limiter.enabled = true;
    limiter.plugin.params.ceiling = -1;
    limiter.plugin.params.truePeak = true;
  }

  // Channels to their buses: every one of a song built now, else only those still on the master.
  let routed = 0;
  for (const [cid, role] of opts.roles) {
    const ch = d.channels[cid];
    const bus = busForRole(role);
    const to = bus ? buses[bus] : undefined;
    if (!ch || ch.kind === 'automation' || !to) continue;
    const onMaster = ch.output === MASTER || !d.mixer.inserts[ch.output];
    if (ch.output === to || (mode === 'fill-gaps' && !onMaster)) continue;
    setChannelProp(d, cid, 'output', to);
    routed++;
    // A level by role for channels nobody has set.
    if (!pinnedChannels.has(cid) && ch.volume === DEFAULT_CHANNEL_VOLUME && ROLE_VOLUME[role] !== DEFAULT_CHANNEL_VOLUME)
      setChannelProp(d, cid, 'volume', ROLE_VOLUME[role]);
  }

  const names = BUS_ORDER.filter((r) => fresh.has(r) && r !== 'reverb' && r !== 'delay').map((r) => BUS_NAMES[r]);
  const returns = (['reverb', 'delay'] as const).filter((r) => fresh.has(r)).map((r) => {
    const fx = busRecipe(r, style).fx.find((f) => f.pluginId !== EQ_PRO);
    return `${BUS_NAMES[r]} (${fx?.label ?? r})`;
  });
  if (names.length || returns.length)
    changes.push(
      `Set up the ${STYLE_LABELS[style]} mix: ${[
        names.length ? `${names.join(', ')} bus${names.length === 1 ? '' : 'es'}` : '',
        returns.length ? `${returns.join(' and ')} return${returns.length === 1 ? '' : 's'}` : '',
      ]
        .filter(Boolean)
        .join(', ')}${reused.length ? ` (on ${reused.join(', ')})` : ''}`,
    );
  if (routed) changes.push(`Routed ${routed} channel${routed === 1 ? '' : 's'} to their buses`);
  if (added.length) changes.push(`Master: ${added.join(', ')}`);
  return { layout: findMixLayout(p), changes };
}
