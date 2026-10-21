/** Read tools for sound sources and processing: the mixer, one channel, the installed plugins and the effect chains. */
import type { ParamSpec, ParamSpecs, PluginDef } from '@agstudio/sdk';
import { MASTER, type Channel, type InsertId, type Project } from '@core/model/types';
import { groupOfInsert } from '@core/query/mix-groups';
import { chainChoices, findChainChoice, type ChainChoice } from '../../chains';
import { presetChoices } from '../../presets';
import type { Services } from '../../services';
import { automationDrives } from '../ops/automation';
import { lower, str } from '../ops/values';
import * as S from '../schema/parts';
import { channelBrief, describeParam, describeParams, pluginName, presetOf, soundChannels } from './describe';
import { rackFields } from './rack-tools';
import { gainDb, mixerNumber, mixerTrackName, projectOf, round2, tool } from './tool';

/** One mixer track with its routes, effects (and their settings) and the channels feeding it. */
function describeInsert(services: Services, project: Project, id: InsertId, includeDefaults: boolean) {
  const insert = project.mixer.inserts[id]!;
  return {
    n: mixerNumber(project, id),
    id,
    name: insert.name,
    ...(insert.color ? { color: insert.color } : {}),
    volume_db: gainDb(insert.volume),
    pan: round2(insert.pan),
    muted: insert.muted,
    solo: insert.solo,
    ...(insert.soloSafe ? { solo_safe: true } : {}),
    ...(groupOfInsert(project.mixer, id) ? { group: groupOfInsert(project.mixer, id)!.name } : {}),
    routes: insert.routes.map((route) => ({
      to: mixerNumber(project, route.to),
      name: mixerTrackName(project, route.to),
      level_db: gainDb(route.level),
      pre: route.pre,
    })),
    channels: project.channelOrder
      .map((channelId) => project.channels[channelId]!)
      .filter((channel) => channel.kind !== 'automation' && channel.output === id)
      .map((channel) => ({ id: channel.id, name: channel.name })),
    fx: insert.fx.map((effect, index) => {
      const definition = services.plugins.get(effect.plugin.pluginId);
      const preset = presetOf(services, definition, effect.plugin, { kind: 'fx', insertId: id, slotId: effect.id });
      return {
        slot: index + 1,
        id: effect.id,
        plugin: effect.plugin.pluginId,
        name: pluginName(services, effect.plugin.pluginId),
        enabled: effect.enabled,
        mix: round2(effect.mix),
        ...(effect.sidechain
          ? {
              sidechain_from: {
                n: mixerNumber(project, effect.sidechain),
                name: mixerTrackName(project, effect.sidechain),
              },
            }
          : {}),
        ...(definition?.kind === 'effect' && definition.sidechain ? { has_sidechain_input: true } : {}),
        ...(preset ? { preset } : {}),
        // A rack: what is inside it (the macros are shown there with their names, so they are left out of the settings).
        ...rackFields(services, project, id, effect),
        params: describeParams(definition, effect.plugin, includeDefaults).filter(
          (param) => !(effect.rack && /^macro[1-8]$/.test(String(param.id))),
        ),
      };
    }),
  };
}

/** Whether anything uses the track: a channel, a route, a sidechain, an effect or a changed setting. */
function isInsertInUse(project: Project, id: InsertId): boolean {
  const insert = project.mixer.inserts[id]!;
  const isUntouched =
    insert.fx.length === 0 &&
    !insert.muted &&
    !insert.solo &&
    insert.volume === 1 &&
    insert.pan === 0 &&
    insert.name === `Insert ${mixerNumber(project, id)}` &&
    insert.routes.length === 1 &&
    insert.routes[0]!.to === MASTER;
  if (id === MASTER || !isUntouched) return true;
  const hasChannel = project.channelOrder.some((channelId) => {
    const channel = project.channels[channelId]!;
    return channel.kind !== 'automation' && channel.output === id;
  });
  const isTargetedByATrack = project.mixer.order.some((otherId) => {
    const other = project.mixer.inserts[otherId]!;
    return other.routes.some((route) => route.to === id) || other.fx.some((effect) => effect.sidechain === id);
  });
  return hasChannel || isTargetedByATrack;
}

export const getMixer = tool(
  'get_mixer',
  'The mixer: every track in use (or one track) with its fader in dB, pan, mute and solo, routes with send levels, the channels playing through it, and its effect slots with their settings (only those that differ from the defaults, with units and ranges), sidechain sources and preset. Tracks nobody uses are only counted (unused_tracks).',
  {
    insert: { ...S.INSERT, description: 'Only this track (default: all).' },
    all_params: S.bool('List every setting of every effect, not only the changed ones.'),
  },
  (services, args, lookup) => {
    const project = projectOf(services);
    const includeDefaults = args.all_params === true;
    if (args.insert !== undefined) {
      return { inserts: [describeInsert(services, project, lookup.insert(args.insert), includeDefaults)] };
    }
    const inUse = project.mixer.order.filter((id) => isInsertInUse(project, id));
    const unused = project.mixer.order
      .filter((id) => !isInsertInUse(project, id))
      .map((id) => mixerNumber(project, id));
    return {
      inserts: inUse.map((id) => describeInsert(services, project, id, includeDefaults)),
      ...(unused.length ? { unused_tracks: unused } : {}),
    };
  },
);

/** An audio-clip channel: its sample and how it is played. */
function describeAudioChannel(project: Project, channel: Extract<Channel, { kind: 'audioClip' }>, common: object) {
  const sample = project.samples[channel.sampleId];
  return {
    ...common,
    sample: sample?.name ?? channel.sampleId,
    ...(channel.pitch ? { pitch_cents: channel.pitch } : {}),
    ...(channel.reverse ? { reverse: true } : {}),
    ...(channel.stretch && channel.stretch !== 'off' ? { follow_tempo: channel.stretch } : {}),
    ...(channel.sourceBpm ? { source_bpm: channel.sourceBpm } : {}),
    ...(channel.filter ? { filter: channel.filter.preset } : {}),
  };
}

/** An instrument channel: its plugin with every setting, preset and samples. */
function describeInstrumentChannel(
  services: Services,
  project: Project,
  channel: Extract<Channel, { kind: 'instrument' }>,
  common: object,
) {
  const definition = services.plugins.get(channel.plugin.pluginId);
  const samples = channel.plugin.samples
    ? Object.fromEntries(
        Object.entries(channel.plugin.samples).map(([slot, sampleId]) => [
          slot,
          project.samples[sampleId]?.name ?? sampleId,
        ]),
      )
    : undefined;
  return {
    ...common,
    pitch_cents: channel.pitch ?? 0,
    root_key: channel.rootKey,
    plugin_version: channel.plugin.pluginVersion,
    preset: presetOf(services, definition, channel.plugin, { kind: 'channel', channelId: channel.id }),
    ...(samples ? { samples } : {}),
    params: describeParams(definition, channel.plugin, true),
    ...(definition ? {} : { error: `the plugin ${channel.plugin.pluginId} isn't installed` }),
  };
}

export const getChannel = tool(
  'get_channel',
  'One channel in full: its plugin with every setting (value, shown text, unit, range or options), preset, volume in dB, pan, pitch, mixer track, mute, solo, and sample. Without a channel: the list of channels.',
  { channel: S.CHANNEL },
  (services, args, lookup) => {
    const project = projectOf(services);
    if (args.channel === undefined) {
      return {
        channels: soundChannels(project).map((channel) => channelBrief(project, services, channel)),
        automation_channels: project.channelOrder.length - soundChannels(project).length,
      };
    }
    const channel = project.channels[lookup.channel(args.channel)]!;
    const brief = channelBrief(project, services, channel);
    if (channel.kind === 'automation') {
      return { ...brief, points: channel.points.length, drives: automationDrives(services, project, channel) };
    }
    const common = {
      ...brief,
      color: channel.color,
      volume_db: gainDb(channel.volume),
      pan: round2(channel.pan),
      muted: channel.muted,
      solo: channel.solo,
      insert: { n: mixerNumber(project, channel.output), name: mixerTrackName(project, channel.output) },
    };
    if (channel.kind === 'audioClip') return describeAudioChannel(project, channel, common);
    return describeInstrumentChannel(services, project, channel, common);
  },
);

const PLUGIN_KINDS = ['instrument', 'effect', 'tool'] as const;
type PluginKind = (typeof PLUGIN_KINDS)[number];

/** Every installed plugin: instruments, effects and the piano-roll tools (scripts). */
function installedPlugins(services: Services): { kind: PluginKind; def: PluginDef }[] {
  return [
    ...services.plugins.list('instrument').map((entry) => ({ kind: 'instrument' as const, def: entry.def })),
    ...services.plugins.list('effect').map((entry) => ({ kind: 'effect' as const, def: entry.def })),
    ...services.plugins.scripts().map((entry) => ({ kind: 'tool' as const, def: entry.def as unknown as PluginDef })),
  ];
}

/** One plugin in full: description, sample slots, preset names and every setting with unit, range and options. */
function describePlugin(services: Services, plugin: { kind: PluginKind; def: PluginDef }) {
  const { def } = plugin;
  return {
    id: def.id,
    name: def.name,
    kind: plugin.kind,
    ...(def.category ? { category: def.category } : {}),
    ...(def.description ? { description: def.description } : {}),
    ...(def.kind === 'effect' && def.sidechain ? { has_sidechain_input: true } : {}),
    ...(def.sampleSlots?.length ? { sample_slots: [...def.sampleSlots] } : {}),
    presets:
      plugin.kind === 'tool'
        ? []
        : presetChoices(def, services.presets).map((preset) => ({ name: preset.name, source: preset.source })),
    params: (Object.entries(def.params as ParamSpecs) as [string, ParamSpec][]).map(([id, spec]) =>
      describeParam(id, spec, undefined),
    ),
  };
}

export const getPlugins = tool(
  'get_plugins',
  'The installed plugins: instruments, effects and piano-roll tools with id, name, category and preset names; give a plugin (id or name) for all its settings with unit, range, default and options.',
  {
    kind: { type: 'string', enum: ['instrument', 'effect', 'tool'], description: 'Only this kind.' },
    plugin: S.str('A plugin id or exact name: its settings in full.'),
  },
  (services, args) => {
    const wanted = str(args.plugin);
    const kind = PLUGIN_KINDS.find((candidate) => candidate === str(args.kind));
    const all = installedPlugins(services);
    if (wanted) {
      const found = all.find((plugin) => plugin.def.id === wanted || lower(plugin.def.name) === lower(wanted));
      if (!found) return { error: `there is no plugin "${wanted}"` };
      return describePlugin(services, found);
    }
    return {
      plugins: all
        .filter((plugin) => !kind || plugin.kind === kind)
        .map((plugin) => ({
          id: plugin.def.id,
          name: plugin.def.name,
          kind: plugin.kind,
          ...(plugin.def.category ? { category: plugin.def.category } : {}),
          ...(plugin.kind !== 'tool'
            ? { presets: presetChoices(plugin.def, services.presets).map((preset) => preset.name) }
            : {}),
        })),
    };
  },
);

/** One chain in full: what it is for and its effects in order. */
function describeChain(services: Services, chain: ChainChoice) {
  return {
    name: chain.name,
    source: chain.source,
    ...(chain.description ? { description: chain.description } : {}),
    effects: chain.steps.map((step) => ({
      plugin: step.pluginId,
      plugin_name: pluginName(services, step.pluginId),
      what: step.label,
      ...(step.preset ? { preset: step.preset } : {}),
      ...(step.params ? { params: step.params } : {}),
      ...(step.mix !== undefined ? { mix: step.mix } : {}),
      ...(step.enabled === false ? { bypassed: true } : {}),
      ...(step.send ? { send_to: step.send.to, send_db: step.send.db } : {}),
    })),
  };
}

export const getChains = tool(
  'get_chains',
  'The effect chains add_chain can put on a mixer track (the factory vocal chains and the musician’s own): name, what it is for, and its effects in order with plugin, preset, settings, dry/wet and send; give a chain name for one in full.',
  { chain: S.str('A chain name (or part of it): only that chain.') },
  (services, args) => {
    const all = chainChoices(services.presets.chains());
    const wanted = str(args.chain);
    if (wanted) {
      const found = findChainChoice(all, wanted);
      return found
        ? describeChain(services, found)
        : { error: `there is no chain "${wanted}"`, chains: all.map((chain) => chain.name) };
    }
    return {
      chains: all.map((chain) => ({
        name: chain.name,
        source: chain.source,
        effects: chain.steps.length,
        ...(chain.description ? { description: chain.description } : {}),
      })),
    };
  },
);
