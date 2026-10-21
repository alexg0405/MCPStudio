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
  setSoloSafe,
} from '@core/ops/mixer';
import { removeRoute, routeOnlyTo, setRoute, setSlotSidechain } from '@core/ops/routing';
import { insertLabel } from '@core/query/mixer';
import { locateSlot } from '@core/query/rack';
import { moveRackFx, removeRackFx } from '@core/ops/racks';
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
        solo_safe: S.bool('true: a solo elsewhere does not silence it (a reverb return, a bus); false: it follows solo like any track.'),
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
    add_insert: (action, context) => {
      const { draft, project } = context;
      const id = newId.insert();
      addInsert(draft, makeInsert(id, str(action.name) ?? `Insert ${draft.mixer.order.length}`));
      const extra: string[] = [];
      const vol = num(action.volume_db);
      if (vol !== undefined) {
        setInsertProp(draft, id, 'volume', insertGain(vol));
        extra.push(`fader ${r2(vol)} dB`);
        context.state.pinnedInserts.add(id);
      }
      const pan = num(action.pan);
      if (pan !== undefined) {
        setInsertProp(draft, id, 'pan', pan);
        extra.push(`pan ${r2(pan)}`);
      }
      const color = str(action.color);
      if (color) setInsertProp(draft, id, 'color', color);
      context.remember(action.ref, { kind: 'insert', id });
      return `Added mixer track ${insertLabel(project, id)} “${draft.mixer.inserts[id]!.name}”${
        extra.length ? ` (${extra.join(', ')})` : ''
      }`;
    },

    edit_insert: (action, context) => {
      const { draft, project } = context;
      const id = context.insert(action.insert);
      const out: string[] = [];
      const name = str(action.name);
      if (name) {
        setInsertProp(draft, id, 'name', name);
        out.push(`renamed “${name}”`);
      }
      const vol = num(action.volume_db);
      if (vol !== undefined) {
        setInsertProp(draft, id, 'volume', insertGain(vol));
        out.push(`fader ${r2(vol)} dB`);
        context.state.pinnedInserts.add(id);
      }
      const pan = num(action.pan);
      if (pan !== undefined) {
        setInsertProp(draft, id, 'pan', pan);
        out.push(`pan ${r2(pan)}`);
      }
      const mute = bool(action.mute);
      if (mute !== undefined) {
        setInsertProp(draft, id, 'muted', mute);
        out.push(mute ? 'muted' : 'unmuted');
      }
      const solo = bool(action.solo);
      if (solo !== undefined) {
        setInsertProp(draft, id, 'solo', solo);
        out.push(solo ? 'solo' : 'unsolo');
      }
      const soloSafe = bool(action.solo_safe);
      if (soloSafe !== undefined) {
        setSoloSafe(draft, id, soloSafe);
        out.push(soloSafe ? 'solo-safe' : 'not solo-safe');
      }
      const color = str(action.color);
      if (color) setInsertProp(draft, id, 'color', color);
      const position = num(action.position);
      if (position !== undefined) {
        if (id === MASTER) context.warn('the Master track stays first');
        else {
          moveInsert(draft, id, Math.round(position));
          out.push(`number ${draft.mixer.order.indexOf(id)}`);
        }
      }
      return out.length ? `${insertLabel(project, id)}: ${out.join(', ')}` : null;
    },

    remove_insert: (action, context) => {
      const id = context.insert(action.insert);
      if (id === MASTER) fail("the Master track can't be deleted");
      const label = insertLabel(context.project, id);
      removeInsert(context.draft, id);
      return `Deleted mixer track ${label}`;
    },

    add_effect: (action, context) => {
      const { draft, project } = context;
      const insertId = context.insert(action.insert);
      const def = context.plugin(action.plugin, 'effect');
      const inst = makePluginInstance(def.id, def.version, defaultValues(def.params)) as Draft<PluginInstance>;
      const parts = context.settings(inst, def, action);
      const pos = num(action.position);
      const slotId = addFxSlot(draft, insertId, inst as PluginInstance, pos !== undefined ? pos - 1 : undefined);
      if (!slotId) fail(`${insertLabel(project, insertId)} has no free effect slot`);
      const mix = num(action.mix);
      if (mix !== undefined) setFxSlotMix(draft, insertId, slotId!, mix > 1 && mix <= 100 ? mix / 100 : mix);
      if (bool(action.enabled) === false) setFxSlotEnabled(draft, insertId, slotId!, false);
      context.remember(action.ref, { kind: 'effect', insertId, slotId: slotId! });
      return `Added ${def.name} to ${insertLabel(project, insertId)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
    },

    edit_effect: (action, context) => {
      const { draft, services, project } = context;
      const { insertId, slotId } = context.effect(action.effect);
      // The effect may be on the track or inside one of its racks (its id is unique on the track).
      const found = locateSlot(draft.mixer.inserts[insertId], slotId);
      const slot = found?.slot as Draft<FxSlot>;
      const out: string[] = [];
      let def = services.plugins.get(slot.plugin.pluginId);
      const swap = str(action.plugin);
      if (swap) {
        def = context.plugin(swap, 'effect');
        replaceFxPlugin(draft, insertId, slotId, makePluginInstance(def.id, def.version, defaultValues(def.params)));
        out.push(`now ${def.name}`);
      }
      if (def && (action.preset !== undefined || action.params !== undefined)) {
        const live = locateSlot(draft.mixer.inserts[insertId], slotId)!.slot;
        out.push(...context.settings(live.plugin as Draft<PluginInstance>, def, action));
      }
      const mix = num(action.mix);
      if (mix !== undefined) {
        setFxSlotMix(draft, insertId, slotId, mix > 1 && mix <= 100 ? mix / 100 : mix);
        out.push(`mix ${Math.round(slot.mix * 100)}%`);
      }
      const enabled = bool(action.enabled);
      if (enabled !== undefined) {
        setFxSlotEnabled(draft, insertId, slotId, enabled);
        out.push(enabled ? 'on' : 'bypassed');
      }
      const pos = num(action.position);
      if (pos !== undefined) {
        // Inside a rack the place is in its branch.
        const branch = found?.branch;
        if (branch) moveRackFx(draft, insertId, slotId, branch.id, pos - 1);
        else moveFxSlot(draft, insertId, slotId, pos - 1);
        out.push(`slot ${pos}`);
      }
      return out.length ? `${def?.name ?? 'Effect'} on ${insertLabel(project, insertId)}: ${out.join(', ')}` : null;
    },

    remove_effect: (action, context) => {
      const { draft, services, project } = context;
      const { insertId, slotId } = context.effect(action.effect);
      const slot = locateSlot(draft.mixer.inserts[insertId], slotId)!.slot;
      const name = services.plugins.get(slot.plugin.pluginId)?.name ?? slot.plugin.pluginId;
      // An effect inside a rack leaves its branch (and its macro mappings); any other leaves the track.
      if (!removeRackFx(draft, insertId, slotId)) removeFxSlot(draft, insertId, slotId);
      return `Removed ${name} from ${insertLabel(project, insertId)}`;
    },

    route: (action, context) => {
      const { draft, project } = context;
      const from = context.insert(action.from);
      const to = context.insert(action.to);
      const level = num(action.level_db);
      const pre = bool(action.pre);
      const ok = setRoute(draft, from, to, {
        ...(level !== undefined ? { level: insertGain(level) } : {}),
        ...(pre !== undefined ? { pre } : {}),
      });
      if (!ok) fail(`${insertLabel(project, from)} can't route to ${insertLabel(project, to)} (it would loop back)`);
      return `${insertLabel(project, from)} → ${insertLabel(project, to)}${level !== undefined ? ` at ${r2(level)} dB` : ''}${pre ? ' (pre-fader)' : ''}`;
    },

    unroute: (action, context) => {
      const from = context.insert(action.from);
      const to = context.insert(action.to);
      removeRoute(context.draft, from, to);
      return `${insertLabel(context.project, from)} no longer routes to ${insertLabel(context.project, to)}`;
    },

    route_only: (action, context) => {
      const { draft, project } = context;
      const from = context.insert(action.from);
      const to = context.insert(action.to);
      if (!routeOnlyTo(draft, from, to))
        fail(`${insertLabel(project, from)} can't route to ${insertLabel(project, to)} (it would loop back)`);
      return `${insertLabel(project, from)} now routes only to ${insertLabel(project, to)}`;
    },

    add_chain: (action, context) => {
      const { draft, services, project } = context;
      const insertId = context.insert(action.insert);
      const name = str(action.chain) ?? fail('which chain?');
      const chain =
        findChainChoice(chainChoices(services.presets.chains()), name!) ??
        fail(`there is no effect chain "${name}" (the catalog lists them)`);
      const mode = lower(str(action.mode) ?? 'replace') === 'append' ? 'append' : 'replace';
      const applied = applyChainToDraft(draft, services, insertId, chain!, mode);
      if (applied.skipped.length) context.warn(`${chain!.name}: left out ${applied.skipped.join('; ')}`);
      // A chain that put nothing anywhere did nothing: say it plainly rather than "Put it on".
      if (applied.slots.length === 0 && applied.sends.length === 0) fail(`${chain!.name} could not be put on ${insertLabel(project, insertId)}: ${applied.skipped.join('; ') || 'it has nothing to add'}`);
      return describeApplied(chain!.name, project, insertId, { ...applied, skipped: [] });
    },

    save_chain: (action, context) => {
      const { services, project } = context;
      const insertId = context.insert(action.insert);
      const name = str(action.name) ?? fail('what should the chain be called?');
      // A plain snapshot: the library keeps it outside the project (and outside this answer's undo step).
      const chain = chainFromInsert(current(context.draft) as unknown as typeof project, insertId, services.plugins, name!);
      if (!chain) fail(`${insertLabel(project, insertId)} has no effects to save`);
      const saved = services.presets.saveChain(chain!);
      return `Saved the ${chain!.steps.length} effect${chain!.steps.length === 1 ? '' : 's'} on ${insertLabel(project, insertId)} as the chain “${saved.name}”`;
    },

    sidechain: (action, context) => {
      const { draft, services, project } = context;
      const { insertId, slotId } = context.effect(action.effect);
      const slot = draft.mixer.inserts[insertId]!.fx.find((f) => f.id === slotId);
      if (!slot) fail('an effect inside a rack keys from its own input: it cannot take a sidechain from a track');
      const def = services.plugins.get(slot!.plugin.pluginId);
      const fromText = str(action.from);
      const source = !fromText || lower(fromText) === 'none' ? null : context.insert(fromText);
      if (source && def?.kind === 'effect' && !def.sidechain) fail(`${def.name} has no sidechain input`);
      if (!setSlotSidechain(draft, insertId, slotId, source)) fail('that sidechain would make audio loop');
      return source
        ? `${def?.name ?? 'Effect'} on ${insertLabel(project, insertId)} listens to ${insertLabel(project, source)}`
        : `${def?.name ?? 'Effect'} on ${insertLabel(project, insertId)}: no sidechain`;
    },
  },
};
