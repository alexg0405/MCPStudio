/** Channels: add, change (instrument, settings, levels, routing, audio clip edits) and remove. */
import type { Draft } from 'immer';
import { makePluginInstance } from '@core/model/defaults';
import type { newId } from '@core/model/ids';
import { MASTER, type PluginInstance } from '@core/model/types';
import { setAudioChannelEdits } from '@core/ops/audio-edits';
import { addChannel, addSample, moveChannel, removeChannel, setChannelProp, setPluginSample } from '@core/ops/channels';
import { insertLabel } from '@core/query/mixer';
import { defaultValues } from '@agstudio/sdk';
import { instrumentChannelFor, kitSampleRef, SAMPLER_ID } from '../../default-project';
import * as S from '../schema/parts';
import type { OpModule } from './context';
import { bool, channelGain, kitSample, num, r2, str } from './values';

export const channels: OpModule = {
  schemas: [
    S.op(
      'add_channel',
      'Adds a channel to the channel rack with an instrument.',
      {
        ref: S.REF,
        plugin: S.PLUGIN,
        name: S.str('Channel name.'),
        sample: S.str(
          'For the Sampler: a built-in kit sound (kick, snare, clap, hat, open-hat, tom-low, tom-mid, tom-high, rim, cowbell, crash).',
        ),
        preset: S.PRESET,
        params: S.PARAMS,
        volume_db: S.num('Channel volume in dB (−60…+1.9; default −2.2).'),
        pan: S.num('−1 (left) … 1 (right).'),
        insert: { ...S.INSERT, description: `${S.INSERT.description} The mixer track it plays through (default Master).` },
        color: S.str('A CSS hex color like "#c76b5b".'),
      },
      ['plugin'],
    ),
    S.op(
      'edit_channel',
      'Changes a channel. "plugin" swaps its instrument (settings reset unless params/preset are given).',
      {
        channel: S.CHANNEL,
        name: S.str('New name.'),
        plugin: S.PLUGIN,
        preset: S.PRESET,
        params: S.PARAMS,
        volume_db: S.num('Channel volume in dB.'),
        pan: S.num('−1 … 1.'),
        mute: S.bool('Mute it.'),
        solo: S.bool('Solo it.'),
        pitch_cents: S.num('Channel pitch in cents (−2400…2400).'),
        sample: S.str('A sampler: swap its built-in kit sound (kick, snare, clap, hat, open-hat, tom-low, tom-mid, tom-high, rim, cowbell, crash).'),
        root_key: S.int('The key the channel’s steps and sample play at (MIDI; 60 = C4).'),
        position: S.int('Move it to this 1-based place in the channel rack.'),
        insert: S.INSERT,
        color: S.str('Hex color.'),
        reverse: S.bool('Audio clip channels: play the sample backwards.'),
        follow_tempo: {
          type: 'string',
          enum: ['off', 'resample', 'stretch'],
          description:
            'Audio clip channels: off = its own speed; resample = speed (and pitch) follow the song tempo; stretch = tempo follows, pitch stays. Needs source_bpm.',
        },
        source_bpm: S.num('Audio clip channels: the tempo the audio was recorded at (20–999).'),
      },
      ['channel'],
    ),
    S.op('remove_channel', 'Deletes a channel and its notes and clips.', { channel: S.CHANNEL }, ['channel']),
  ],
  handlers: {
    add_channel: (action, context) => {
      const { draft, project } = context;
      const def = context.plugin(action.plugin, 'instrument');
      const name = str(action.name) ?? def.name;
      let samples: Record<string, ReturnType<typeof newId.sample>> | undefined;
      if (def.sampleSlots?.includes('main') || def.id === SAMPLER_ID) {
        const generator = kitSample(action.sample, name);
        if (generator) {
          const ref = kitSampleRef(generator);
          addSample(draft, ref);
          samples = { main: ref.id };
        } else if (def.id === SAMPLER_ID)
          // Other sample players have a sound of their own until they get one (the Slicer's demo break).
          context.warn(`"${name}" has no sample yet (say which kit sound it should play)`);
      }
      const channel = instrumentChannelFor(def, name, draft.channelOrder.length, samples);
      const parts = context.settings(channel.plugin as Draft<PluginInstance>, def, action);
      const vol = num(action.volume_db);
      if (vol !== undefined) {
        channel.volume = channelGain(vol);
        parts.push(`volume ${r2(vol)} dB`);
      }
      const pan = num(action.pan);
      if (pan !== undefined) {
        channel.pan = Math.max(-1, Math.min(1, pan));
        parts.push(`pan ${r2(pan)}`);
      }
      const color = str(action.color);
      if (color && /^#[0-9a-f]{6}$/i.test(color)) channel.color = color;
      if (action.insert !== undefined) channel.output = context.insert(action.insert);
      addChannel(draft, channel);
      context.remember(action.ref, { kind: 'channel', id: channel.id });
      context.state.after.push({ kind: 'open', window: 'channel-rack' });
      context.state.selectChannel = channel.id;
      return `Added channel “${name}” (${def.name}${parts.length ? `: ${parts.join(', ')}` : ''})${
        channel.output !== MASTER ? ` → ${insertLabel(project, channel.output)}` : ''
      }`;
    },

    edit_channel: (action, context) => {
      const { draft, services, project } = context;
      const id = context.channel(action.channel);
      const channel = draft.channels[id]!;
      const out: string[] = [];
      if (channel.kind === 'instrument') {
        const swap = str(action.plugin);
        let def = services.plugins.get(channel.plugin.pluginId);
        if (swap) {
          def = context.plugin(swap, 'instrument');
          channel.plugin = makePluginInstance(def.id, def.version, defaultValues(def.params), {
            ...(channel.plugin.samples && def.sampleSlots?.length ? { samples: { ...channel.plugin.samples } } : {}),
          }) as Draft<PluginInstance>;
          out.push(`instrument ${def.name}`);
        }
        if (def && (action.preset !== undefined || action.params !== undefined)) out.push(...context.settings(channel.plugin, def, action));
        else if (!def && (action.preset !== undefined || action.params !== undefined))
          context.warn(`“${channel.name}”'s plugin isn't installed`);
        const pitch = num(action.pitch_cents);
        if (pitch !== undefined) {
          channel.pitch = Math.max(-2400, Math.min(2400, pitch));
          out.push(`pitch ${channel.pitch} ct`);
        }
        const sample = str(action.sample);
        if (action.sample !== undefined) {
          const slot = def?.sampleSlots?.includes('main') || def?.id === SAMPLER_ID;
          const generator = slot ? kitSample(sample, '') : undefined;
          if (!slot) context.warn(`“${channel.name}” doesn't play a sample`);
          else if (!generator) context.warn(`there is no kit sound "${String(action.sample)}"`);
          else {
            const ref = kitSampleRef(generator);
            addSample(draft, ref);
            setPluginSample(draft, { kind: 'channel', channelId: id }, 'main', ref.id);
            out.push(`sound ${ref.name}`);
          }
        }
        const rootKey = num(action.root_key);
        if (rootKey !== undefined) {
          setChannelProp(draft, id, 'rootKey', rootKey);
          out.push(`root key ${channel.rootKey}`);
        }
      } else if (action.plugin !== undefined || action.params !== undefined || action.preset !== undefined)
        context.warn(`“${channel.name}” has no instrument`);
      if (channel.kind === 'audioClip') {
        const pitch = num(action.pitch_cents);
        const reverse = bool(action.reverse);
        const follow = (['off', 'resample', 'stretch'] as const).find((x) => x === str(action.follow_tempo));
        const bpm = num(action.source_bpm);
        setAudioChannelEdits(draft, id, {
          ...(pitch !== undefined ? { pitch } : {}),
          ...(reverse !== undefined ? { reverse } : {}),
          ...(follow ? { stretch: follow } : {}),
          ...(bpm !== undefined ? { sourceBpm: bpm } : {}),
        });
        if (pitch !== undefined) out.push(`pitch ${channel.pitch ?? 0} ct`);
        if (reverse !== undefined) out.push(reverse ? 'reversed' : 'forwards');
        if (follow) out.push(follow === 'off' ? 'own speed' : `follows the tempo (${follow})`);
        if (bpm !== undefined) out.push(`recorded at ${channel.sourceBpm} BPM`);
        if (follow && follow !== 'off' && channel.sourceBpm === undefined)
          context.warn(`“${channel.name}” needs source_bpm to follow the tempo`);
      } else if (action.reverse !== undefined || action.follow_tempo !== undefined || action.source_bpm !== undefined)
        context.warn(`“${channel.name}” is not an audio clip channel`);
      const name = str(action.name);
      if (name) {
        setChannelProp(draft, id, 'name', name);
        out.push(`renamed “${name}”`);
      }
      const vol = num(action.volume_db);
      if (vol !== undefined) {
        setChannelProp(draft, id, 'volume', channelGain(vol));
        out.push(`volume ${r2(vol)} dB`);
      }
      const pan = num(action.pan);
      if (pan !== undefined) {
        setChannelProp(draft, id, 'pan', pan);
        out.push(`pan ${r2(pan)}`);
      }
      const mute = bool(action.mute);
      if (mute !== undefined) {
        channel.muted = mute;
        out.push(mute ? 'muted' : 'unmuted');
      }
      const solo = bool(action.solo);
      if (solo !== undefined) {
        channel.solo = solo;
        out.push(solo ? 'solo' : 'unsolo');
      }
      if (action.insert !== undefined) {
        const to = context.insert(action.insert);
        setChannelProp(draft, id, 'output', to);
        out.push(`→ ${insertLabel(project, to)}`);
      }
      const color = str(action.color);
      if (color && /^#[0-9a-f]{6}$/i.test(color)) setChannelProp(draft, id, 'color', color);
      const position = num(action.position);
      if (position !== undefined) {
        moveChannel(draft, id, Math.round(position) - 1);
        out.push(`place ${draft.channelOrder.indexOf(id) + 1}`);
      }
      return out.length ? `“${channel.name}”: ${out.join(', ')}` : null;
    },

    remove_channel: (action, context) => {
      const id = context.channel(action.channel);
      const name = context.draft.channels[id]!.name;
      context.focus.removing(id, name);
      removeChannel(context.draft, id);
      return `Deleted channel “${name}”`;
    },
  },
};
