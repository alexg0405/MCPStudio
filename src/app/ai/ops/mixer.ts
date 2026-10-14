/** The mixer: tracks, effect slots, routes and sidechains. */
import type { Draft } from 'immer';
import { makeInsert, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { MASTER, type FxSlot, type PluginInstance } from '@core/model/types';
import {
  addFxSlot,
  addInsert,
  moveFxSlot,
  removeFxSlot,
  removeInsert,
  replaceFxPlugin,
  setFxSlotEnabled,
  setFxSlotMix,
  setInsertProp,
} from '@core/ops/mixer';
import { removeRoute, routeOnlyTo, setRoute, setSlotSidechain } from '@core/ops/routing';
import { insertLabel } from '@core/query/mixer';
import { defaultValues } from '@agstudio/sdk';
import * as S from '../schema/parts';
import { fail, type OpModule } from './context';
import { bool, insertGain, lower, num, r2, str } from './values';

export const mixer: OpModule = {
  schemas: [
    S.op('add_insert', 'Adds a mixer track (routed to Master).', {
      ref: S.REF,
      name: S.str('Track name, e.g. "Drum bus".'),
      volume_db: S.num('Fader in dB (−60…+5.6).'),
      pan: S.num('−1 … 1.'),
      color: S.str('Hex color.'),
    }),
    S.op(
      'edit_insert',
      'Changes a mixer track.',
      {
        insert: S.INSERT,
        name: S.str('New name.'),
        volume_db: S.num('Fader in dB (−60…+5.6; 0 = unity).'),
        pan: S.num('−1 … 1.'),
        mute: S.bool('Mute it.'),
        solo: S.bool('Solo it (FL-style: its sources keep playing).'),
        color: S.str('Hex color.'),
      },
      ['insert'],
    ),
    S.op('remove_insert', 'Deletes a mixer track (its channels go to Master).', { insert: S.INSERT }, ['insert']),
    S.op(
      'add_effect',
      'Adds an effect to a mixer track’s slots.',
      {
        ref: S.REF,
        insert: S.INSERT,
        plugin: S.PLUGIN,
        preset: S.PRESET,
        params: S.PARAMS,
        mix: S.num('Dry/wet 0..1 (default 1).'),
        enabled: S.bool('false to add it bypassed.'),
        position: S.int('1-based slot position (default: after the last).'),
      },
      ['insert', 'plugin'],
    ),
    S.op(
      'edit_effect',
      'Changes an effect slot. "plugin" replaces the effect.',
      {
        effect: S.EFFECT,
        plugin: S.PLUGIN,
        preset: S.PRESET,
        params: S.PARAMS,
        mix: S.num('Dry/wet 0..1.'),
        enabled: S.bool('false bypasses it.'),
        position: S.int('Move it to this 1-based slot.'),
      },
      ['effect'],
    ),
    S.op('remove_effect', 'Removes an effect slot.', { effect: S.EFFECT }, ['effect']),
    S.op(
      'route',
      'Sends a mixer track into another track (adds the route, or changes its level).',
      {
        from: S.INSERT,
        to: S.INSERT,
        level_db: S.num('Send level in dB (default 0).'),
        pre: S.bool('Take it before the fader (pre-fader send).'),
      },
      ['from', 'to'],
    ),
    S.op('unroute', 'Removes the route from one track to another.', { from: S.INSERT, to: S.INSERT }, ['from', 'to']),
    S.op(
      'route_only',
      'FL’s "Route to this track only": the track’s only route becomes `to`.',
      { from: S.INSERT, to: S.INSERT },
      ['from', 'to'],
    ),
    S.op(
      'sidechain',
      'Feeds an effect’s sidechain input (effects marked "has a sidechain input") from a mixer track, or "none".',
      { effect: S.EFFECT, from: S.INSERT },
      ['effect', 'from'],
    ),
  ],
  handlers: {
    add_insert: (a, c) => {
      const { d, project } = c;
      const id = newId.insert();
      addInsert(d, makeInsert(id, str(a.name) ?? `Insert ${d.mixer.order.length}`));
      const extra: string[] = [];
      const vol = num(a.volume_db);
      if (vol !== undefined) {
        setInsertProp(d, id, 'volume', insertGain(vol));
        extra.push(`fader ${r2(vol)} dB`);
        c.state.pinnedInserts.add(id);
      }
      const pan = num(a.pan);
      if (pan !== undefined) {
        setInsertProp(d, id, 'pan', pan);
        extra.push(`pan ${r2(pan)}`);
      }
      const color = str(a.color);
      if (color) setInsertProp(d, id, 'color', color);
      c.remember(a.ref, { kind: 'insert', id });
      return `Added mixer track ${insertLabel(project, id)} “${d.mixer.inserts[id]!.name}”${
        extra.length ? ` (${extra.join(', ')})` : ''
      }`;
    },

    edit_insert: (a, c) => {
      const { d, project } = c;
      const id = c.insert(a.insert);
      const out: string[] = [];
      const name = str(a.name);
      if (name) {
        setInsertProp(d, id, 'name', name);
        out.push(`renamed “${name}”`);
      }
      const vol = num(a.volume_db);
      if (vol !== undefined) {
        setInsertProp(d, id, 'volume', insertGain(vol));
        out.push(`fader ${r2(vol)} dB`);
        c.state.pinnedInserts.add(id);
      }
      const pan = num(a.pan);
      if (pan !== undefined) {
        setInsertProp(d, id, 'pan', pan);
        out.push(`pan ${r2(pan)}`);
      }
      const mute = bool(a.mute);
      if (mute !== undefined) {
        setInsertProp(d, id, 'muted', mute);
        out.push(mute ? 'muted' : 'unmuted');
      }
      const solo = bool(a.solo);
      if (solo !== undefined) {
        setInsertProp(d, id, 'solo', solo);
        out.push(solo ? 'solo' : 'unsolo');
      }
      const color = str(a.color);
      if (color) setInsertProp(d, id, 'color', color);
      return out.length ? `${insertLabel(project, id)}: ${out.join(', ')}` : null;
    },

    remove_insert: (a, c) => {
      const id = c.insert(a.insert);
      if (id === MASTER) fail("the Master track can't be deleted");
      const label = insertLabel(c.project, id);
      removeInsert(c.d, id);
      return `Deleted mixer track ${label}`;
    },

    add_effect: (a, c) => {
      const { d, project } = c;
      const insertId = c.insert(a.insert);
      const def = c.plugin(a.plugin, 'effect');
      const inst = makePluginInstance(def.id, def.version, defaultValues(def.params)) as Draft<PluginInstance>;
      const parts = c.settings(inst, def, a);
      const pos = num(a.position);
      const slotId = addFxSlot(d, insertId, inst as PluginInstance, pos !== undefined ? pos - 1 : undefined);
      if (!slotId) fail(`${insertLabel(project, insertId)} has no free effect slot`);
      const mix = num(a.mix);
      if (mix !== undefined) setFxSlotMix(d, insertId, slotId!, mix > 1 && mix <= 100 ? mix / 100 : mix);
      if (bool(a.enabled) === false) setFxSlotEnabled(d, insertId, slotId!, false);
      c.remember(a.ref, { kind: 'effect', insertId, slotId: slotId! });
      return `Added ${def.name} to ${insertLabel(project, insertId)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    },

    edit_effect: (a, c) => {
      const { d, s, project } = c;
      const { insertId, slotId } = c.effect(a.effect);
      const slot = d.mixer.inserts[insertId]!.fx.find((f) => f.id === slotId) as Draft<FxSlot>;
      const out: string[] = [];
      let def = s.plugins.get(slot.plugin.pluginId);
      const swap = str(a.plugin);
      if (swap) {
        def = c.plugin(swap, 'effect');
        replaceFxPlugin(d, insertId, slotId, makePluginInstance(def.id, def.version, defaultValues(def.params)));
        out.push(`now ${def.name}`);
      }
      if (def && (a.preset !== undefined || a.params !== undefined)) {
        const live = d.mixer.inserts[insertId]!.fx.find((f) => f.id === slotId)!;
        out.push(...c.settings(live.plugin, def, a));
      }
      const mix = num(a.mix);
      if (mix !== undefined) {
        setFxSlotMix(d, insertId, slotId, mix > 1 && mix <= 100 ? mix / 100 : mix);
        out.push(`mix ${Math.round(slot.mix * 100)}%`);
      }
      const enabled = bool(a.enabled);
      if (enabled !== undefined) {
        setFxSlotEnabled(d, insertId, slotId, enabled);
        out.push(enabled ? 'on' : 'bypassed');
      }
      const pos = num(a.position);
      if (pos !== undefined) {
        moveFxSlot(d, insertId, slotId, pos - 1);
        out.push(`slot ${pos}`);
      }
      return out.length ? `${def?.name ?? 'Effect'} on ${insertLabel(project, insertId)}: ${out.join(', ')}` : null;
    },

    remove_effect: (a, c) => {
      const { d, s, project } = c;
      const { insertId, slotId } = c.effect(a.effect);
      const slot = d.mixer.inserts[insertId]!.fx.find((f) => f.id === slotId)!;
      const name = s.plugins.get(slot.plugin.pluginId)?.name ?? slot.plugin.pluginId;
      removeFxSlot(d, insertId, slotId);
      return `Removed ${name} from ${insertLabel(project, insertId)}`;
    },

    route: (a, c) => {
      const { d, project } = c;
      const from = c.insert(a.from);
      const to = c.insert(a.to);
      const level = num(a.level_db);
      const pre = bool(a.pre);
      const ok = setRoute(d, from, to, {
        ...(level !== undefined ? { level: insertGain(level) } : {}),
        ...(pre !== undefined ? { pre } : {}),
      });
      if (!ok) fail(`${insertLabel(project, from)} can't route to ${insertLabel(project, to)} (it would loop back)`);
      return `${insertLabel(project, from)} → ${insertLabel(project, to)}${level !== undefined ? ` at ${r2(level)} dB` : ''}${pre ? ' (pre-fader)' : ''}`;
    },

    unroute: (a, c) => {
      const from = c.insert(a.from);
      const to = c.insert(a.to);
      removeRoute(c.d, from, to);
      return `${insertLabel(c.project, from)} no longer routes to ${insertLabel(c.project, to)}`;
    },

    route_only: (a, c) => {
      const { d, project } = c;
      const from = c.insert(a.from);
      const to = c.insert(a.to);
      if (!routeOnlyTo(d, from, to))
        fail(`${insertLabel(project, from)} can't route to ${insertLabel(project, to)} (it would loop back)`);
      return `${insertLabel(project, from)} now routes only to ${insertLabel(project, to)}`;
    },

    sidechain: (a, c) => {
      const { d, s, project } = c;
      const { insertId, slotId } = c.effect(a.effect);
      const slot = d.mixer.inserts[insertId]!.fx.find((f) => f.id === slotId)!;
      const def = s.plugins.get(slot.plugin.pluginId);
      const fromText = str(a.from);
      const source = !fromText || lower(fromText) === 'none' ? null : c.insert(fromText);
      if (source && def?.kind === 'effect' && !def.sidechain) fail(`${def.name} has no sidechain input`);
      if (!setSlotSidechain(d, insertId, slotId, source)) fail('that sidechain would make audio loop');
      return source
        ? `${def?.name ?? 'Effect'} on ${insertLabel(project, insertId)} listens to ${insertLabel(project, source)}`
        : `${def?.name ?? 'Effect'} on ${insertLabel(project, insertId)}: no sidechain`;
    },
  },
};
