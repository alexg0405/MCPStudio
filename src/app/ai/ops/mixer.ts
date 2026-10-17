/** The mixer: tracks, effect slots, routes and sidechains. */
import { current, type Draft } from 'immer';
import { makeInsert, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { MASTER, type FxSlot, type PluginInstance } from '@core/model/types';
import {
  addFxSlot,
  addInsert,
  moveFxSlot,
  moveInsert,
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
import { describeApplied, applyChainToDraft } from '../../actions/chains';
import { chainChoices, chainFromInsert, findChainChoice } from '../../chains';
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
        position: S.int('Move it to this mixer number (1 or more; Master stays first).'),
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
      'add_chain',
      'Puts a whole effect chain on a mixer track in one action (the vocal chains, or one the musician saved): its effects in order, with their settings. Its reverb and delay go to the song’s Reverb and Delay return tracks as sends when it has them, otherwise they are effects on the track.',
      {
        insert: S.INSERT,
        chain: S.str('A chain name from the catalog: "Clean pop vocal", "Rap vocal", "Airy ballad", "Lo-fi vocal", "Trap auto-tune vocal", "Podcast voice", or one of the musician’s own.'),
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'replace (default): take off the track’s effects first. append: add the chain after them.',
        },
      },
      ['insert', 'chain'],
    ),
    S.op(
      'save_chain',
      'Saves the effects on a mixer track, with every setting, as one of the musician’s own chains (add_chain can put it on any track later). A chain of the same name is replaced.',
      { insert: S.INSERT, name: S.str('The chain’s name, e.g. "My lead vocal".') },
      ['insert', 'name'],
    ),
    S.op(
      'sidechain',
      'Feeds an effect’s sidechain input (effects marked "has a sidechain input") from a mixer track, or "none".',
      { effect: S.EFFECT, from: S.INSERT },
      ['effect', 'from'],
    ),
  ],
  prompt: {
    id: 'chains',
    order: 26,
    text: `Effect chains (add_chain, save_chain):
- A vocal (or any voice) gets a ready-made chain in one action: add_chain with its mixer track and a chain name from the catalog (Clean pop vocal, Rap vocal, Airy ballad, Lo-fi vocal, Trap auto-tune vocal, Podcast voice, or the musician's own). It replaces the track's effects (mode: append adds after them). Reverb and delay go to the song's Reverb and Delay return tracks as sends when it has them, so put the chain on the vocal's own track, after setup_mix. Don't build a vocal chain from separate add_effect actions unless they ask for something the chains don't do; tweak a chain's effects afterwards with edit_effect.
- Trap auto-tune vocal starts Tune in A minor: set Tune's key and scale to the song's key with edit_effect. The De-esser (agstudio.de-esser) tames harsh "s" sounds (frequency 5-9 kHz; Listen plays the band it watches) and the Doubler (agstudio.doubler) layers quiet, drifting, spread copies under a voice.
- The mix setup puts voices (channels named vox, vocal, voice) on a Vocals bus with EQ, compressor and de-esser, sends to Reverb and Delay; a chain on the vocal's own track goes before that bus. save_chain keeps a track's effects as a chain of the musician's own.`,
  },
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
      const position = num(a.position);
      if (position !== undefined) {
        if (id === MASTER) c.warn('the Master track stays first');
        else {
          moveInsert(d, id, Math.round(position));
          out.push(`number ${d.mixer.order.indexOf(id)}`);
        }
      }
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

    add_chain: (a, c) => {
      const { d, s, project } = c;
      const insertId = c.insert(a.insert);
      const name = str(a.chain) ?? fail('which chain?');
      const chain =
        findChainChoice(chainChoices(s.presets.chains()), name!) ??
        fail(`there is no effect chain "${name}" (the catalog lists them)`);
      const mode = lower(str(a.mode) ?? 'replace') === 'append' ? 'append' : 'replace';
      const applied = applyChainToDraft(d, s, insertId, chain!, mode);
      if (applied.skipped.length) c.warn(`${chain!.name}: left out ${applied.skipped.join('; ')}`);
      // A chain that put nothing anywhere did nothing: say it plainly rather than "Put it on".
      if (applied.slots.length === 0 && applied.sends.length === 0) fail(`${chain!.name} could not be put on ${insertLabel(project, insertId)}: ${applied.skipped.join('; ') || 'it has nothing to add'}`);
      return describeApplied(chain!.name, project, insertId, { ...applied, skipped: [] });
    },

    save_chain: (a, c) => {
      const { s, project } = c;
      const insertId = c.insert(a.insert);
      const name = str(a.name) ?? fail('what should the chain be called?');
      // A plain snapshot: the library keeps it outside the project (and outside this answer's undo step).
      const chain = chainFromInsert(current(c.d) as unknown as typeof project, insertId, s.plugins, name!);
      if (!chain) fail(`${insertLabel(project, insertId)} has no effects to save`);
      const saved = s.presets.saveChain(chain!);
      return `Saved the ${chain!.steps.length} effect${chain!.steps.length === 1 ? '' : 's'} on ${insertLabel(project, insertId)} as the chain “${saved.name}”`;
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
