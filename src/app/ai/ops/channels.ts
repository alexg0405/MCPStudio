/** Channels: add, change (instrument, settings, levels, routing, audio clip edits) and remove. */
import type { Draft } from 'immer';
import { makePluginInstance } from '@core/model/defaults';
import type { newId } from '@core/model/ids';
import { MASTER, type PluginInstance } from '@core/model/types';
import { setAudioChannelEdits } from '@core/ops/audio-edits';
import { addChannel, addSample, removeChannel, setChannelProp } from '@core/ops/channels';
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
    add_channel: (a, c) => {
      const { d, project } = c;
      const def = c.plugin(a.plugin, 'instrument');
      const name = str(a.name) ?? def.name;
      let samples: Record<string, ReturnType<typeof newId.sample>> | undefined;
      if (def.sampleSlots?.includes('main') || def.id === SAMPLER_ID) {
        const generator = kitSample(a.sample, name);
        if (generator) {
          const ref = kitSampleRef(generator);
          addSample(d, ref);
          samples = { main: ref.id };
        } else if (def.id === SAMPLER_ID)
          // Other sample players have a sound of their own until they get one (the Slicer's demo break).
          c.warn(`"${name}" has no sample yet (say which kit sound it should play)`);
      }
      const ch = instrumentChannelFor(def, name, d.channelOrder.length, samples);
      const parts = c.settings(ch.plugin as Draft<PluginInstance>, def, a);
      const vol = num(a.volume_db);
      if (vol !== undefined) {
        ch.volume = channelGain(vol);
        parts.push(`volume ${r2(vol)} dB`);
      }
      const pan = num(a.pan);
      if (pan !== undefined) {
        ch.pan = Math.max(-1, Math.min(1, pan));
        parts.push(`pan ${r2(pan)}`);
      }
      const color = str(a.color);
      if (color && /^#[0-9a-f]{6}$/i.test(color)) ch.color = color;
      if (a.insert !== undefined) ch.output = c.insert(a.insert);
      addChannel(d, ch);
      c.remember(a.ref, { kind: 'channel', id: ch.id });
      c.state.after.push({ kind: 'open', window: 'channel-rack' });
      c.state.selectChannel = ch.id;
      return `Added channel “${name}” (${def.name}${parts.length ? `: ${parts.join(', ')}` : ''})${
        ch.output !== MASTER ? ` → ${insertLabel(project, ch.output)}` : ''
      }`;
    },

    edit_channel: (a, c) => {
      const { d, s, project } = c;
      const id = c.channel(a.channel);
      const ch = d.channels[id]!;
      const out: string[] = [];
      if (ch.kind === 'instrument') {
        const swap = str(a.plugin);
        let def = s.plugins.get(ch.plugin.pluginId);
        if (swap) {
          def = c.plugin(swap, 'instrument');
          ch.plugin = makePluginInstance(def.id, def.version, defaultValues(def.params), {
            ...(ch.plugin.samples && def.sampleSlots?.length ? { samples: { ...ch.plugin.samples } } : {}),
          }) as Draft<PluginInstance>;
          out.push(`instrument ${def.name}`);
        }
        if (def && (a.preset !== undefined || a.params !== undefined)) out.push(...c.settings(ch.plugin, def, a));
        else if (!def && (a.preset !== undefined || a.params !== undefined))
          c.warn(`“${ch.name}”'s plugin isn't installed`);
        const pitch = num(a.pitch_cents);
        if (pitch !== undefined) {
          ch.pitch = Math.max(-2400, Math.min(2400, pitch));
          out.push(`pitch ${ch.pitch} ct`);
        }
      } else if (a.plugin !== undefined || a.params !== undefined || a.preset !== undefined)
        c.warn(`“${ch.name}” has no instrument`);
      if (ch.kind === 'audioClip') {
        const pitch = num(a.pitch_cents);
        const reverse = bool(a.reverse);
        const follow = (['off', 'resample', 'stretch'] as const).find((x) => x === str(a.follow_tempo));
        const bpm = num(a.source_bpm);
        setAudioChannelEdits(d, id, {
          ...(pitch !== undefined ? { pitch } : {}),
          ...(reverse !== undefined ? { reverse } : {}),
          ...(follow ? { stretch: follow } : {}),
          ...(bpm !== undefined ? { sourceBpm: bpm } : {}),
        });
        if (pitch !== undefined) out.push(`pitch ${ch.pitch ?? 0} ct`);
        if (reverse !== undefined) out.push(reverse ? 'reversed' : 'forwards');
        if (follow) out.push(follow === 'off' ? 'own speed' : `follows the tempo (${follow})`);
        if (bpm !== undefined) out.push(`recorded at ${ch.sourceBpm} BPM`);
        if (follow && follow !== 'off' && ch.sourceBpm === undefined)
          c.warn(`“${ch.name}” needs source_bpm to follow the tempo`);
      } else if (a.reverse !== undefined || a.follow_tempo !== undefined || a.source_bpm !== undefined)
        c.warn(`“${ch.name}” is not an audio clip channel`);
      const name = str(a.name);
      if (name) {
        setChannelProp(d, id, 'name', name);
        out.push(`renamed “${name}”`);
      }
      const vol = num(a.volume_db);
      if (vol !== undefined) {
        setChannelProp(d, id, 'volume', channelGain(vol));
        out.push(`volume ${r2(vol)} dB`);
      }
      const pan = num(a.pan);
      if (pan !== undefined) {
        setChannelProp(d, id, 'pan', pan);
        out.push(`pan ${r2(pan)}`);
      }
      const mute = bool(a.mute);
      if (mute !== undefined) {
        ch.muted = mute;
        out.push(mute ? 'muted' : 'unmuted');
      }
      const solo = bool(a.solo);
      if (solo !== undefined) {
        ch.solo = solo;
        out.push(solo ? 'solo' : 'unsolo');
      }
      if (a.insert !== undefined) {
        const to = c.insert(a.insert);
        setChannelProp(d, id, 'output', to);
        out.push(`→ ${insertLabel(project, to)}`);
      }
      const color = str(a.color);
      if (color && /^#[0-9a-f]{6}$/i.test(color)) setChannelProp(d, id, 'color', color);
      return out.length ? `“${ch.name}”: ${out.join(', ')}` : null;
    },

    remove_channel: (a, c) => {
      const id = c.channel(a.channel);
      const name = c.d.channels[id]!.name;
      removeChannel(c.d, id);
      return `Deleted channel “${name}”`;
    },
  },
};
