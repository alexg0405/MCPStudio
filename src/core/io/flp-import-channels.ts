/**
 * FL import, channel step: every FL channel becomes an instrument, an audio clip channel or an automation
 * channel (layers become their children), and automation channels get the target FL kept apart from them.
 */
import { paletteColor } from '../model/defaults';
import { newId } from '../model/ids';
import { KIT_VERSION, kitPiece } from '../model/kit';
import type {
  AudioClipChannel,
  AutomationChannel,
  Channel,
  ChannelId,
  InstrumentChannel,
  InsertId,
  ParamTarget,
  PluginInstance,
  SampleRef,
} from '../model/types';
import { PPQ } from '../time/ppq';
import { FLP_CHANNEL_TYPE, flpFileName, type FlpChannel, type FlpArrangement } from './flp';
import { generatorChoice, isSamplerChannel, isVst, pluginLabel, type PluginChoice } from './flp-import-plugins';
import { FLP_PLUGIN, clamp, trimName, type FlpImportContext } from './flp-import-types';

/** FL channel volume: 12800 is full scale; AGstudio allows up to 1.25 (+2 dB). */
const FL_CHANNEL_VOLUME_FULL = 12800;
const CHANNEL_VOLUME_MAX = 1.25;
/** Volume of a channel the file gives none (AGstudio's usual default). */
const DEFAULT_CHANNEL_VOLUME = 0.78;
/** FL channel pan: 0 (left) … 12800 (right), centre 6400. */
const FL_CHANNEL_PAN_CENTER = 6400;
/** The widest channel pitch offset, in cents (two octaves each way). */
const CHANNEL_PITCH_CENTS_MAX = 2400;
/** FL's default root key (C5 = key 60 here too). */
const DEFAULT_ROOT_KEY = 60;
const MIDI_KEY_MAX = 127;
/** An automation link's destination with this bit set points at something other than a channel. */
const AUTOMATION_LINK_NOT_A_CHANNEL = 0x2000;
const AUTOMATION_LINK_PARAM_MASK = 0x7fff;
/** The channel parameters FL automation links name by number. */
const LINK_PARAM_VOLUME = 0;
const LINK_PARAM_PAN = 1;

/** What later steps need from the channels: FL channel number → ours, and the layers' children. */
export interface ChannelImport {
  byIid: Map<number, ChannelId>;
  /** Layer channel number → its children's channel numbers (layers make no sound themselves). */
  layers: Map<number, number[]>;
}

/** The fields every kind of channel shares. */
interface ChannelBase {
  name: string;
  color: string;
  muted: boolean;
  solo: boolean;
}

/** The mixing fields of instrument and audio clip channels, read from the FL channel. */
interface ChannelMix {
  volume: number;
  pan: number;
  /** Cents, 0 when none. */
  pitch: number;
  output: InsertId;
}

/** Builds `project.channels`, `channelOrder` and `samples`, counting channels in the report. */
export function importChannels(
  ctx: FlpImportContext,
  arrangement: FlpArrangement,
  insertFor: (flInsert: number | undefined) => InsertId,
): ChannelImport {
  const importer = new ChannelImporter(ctx, arrangement, insertFor);
  return importer.run();
}

class ChannelImporter {
  private readonly byIid = new Map<number, ChannelId>();
  private readonly layers = new Map<number, number[]>();
  private readonly channels: Channel[] = [];
  private readonly samples: Record<string, SampleRef> = {};
  /** FL channel numbers that have notes in some pattern. */
  private readonly hasNotes = new Set<number>();
  /** FL channel numbers that appear as clips in the imported playlist. */
  private readonly inPlaylist = new Set<number>();

  constructor(
    private readonly ctx: FlpImportContext,
    arrangement: FlpArrangement,
    private readonly insertFor: (flInsert: number | undefined) => InsertId,
  ) {
    for (const pattern of ctx.flp.patterns) for (const note of pattern.notes) this.hasNotes.add(note.channel);
    for (const item of arrangement.items) if (item.kind === 'channel') this.inPlaylist.add(item.ref);
  }

  run(): ChannelImport {
    const flChannels = [...this.ctx.flp.channels].sort((a, b) => a.iid - b.iid);
    flChannels.forEach((flChannel, index) => this.importChannel(flChannel, index));
    this.linkAutomationTargets();

    const { project, report } = this.ctx;
    project.channels = {};
    project.channelOrder = [];
    for (const channel of this.channels) {
      project.channels[channel.id] = channel;
      project.channelOrder.push(channel.id);
    }
    project.samples = this.samples as typeof project.samples;
    report.channels = this.channels.length;
    return { byIid: this.byIid, layers: this.layers };
  }

  private add(flChannel: FlpChannel, channel: Channel): void {
    this.byIid.set(flChannel.iid, channel.id);
    this.channels.push(channel);
  }

  /** The sample for an FL sample path; a missing file is reported (and still gets a reference). */
  private sampleFor(path: string | undefined, channelName: string): SampleRef | undefined {
    if (!path) return undefined;
    const resolved = this.ctx.opts.samples.get(path);
    if (!resolved?.found) {
      this.ctx.report.missingSamples.push({ channel: channelName, file: flpFileName(path) || path, path });
    }
    if (!resolved) return undefined;
    this.samples[resolved.ref.id] = resolved.ref;
    return resolved.ref;
  }

  private importChannel(flChannel: FlpChannel, index: number): void {
    const color = flChannel.color ?? paletteColor(index);
    const fallbackName = flChannel.samplePath
      ? stemOf(flpFileName(flChannel.samplePath))
      : flChannel.internalName || `Channel ${flChannel.iid + 1}`;
    const name = trimName(flChannel.name?.trim() || fallbackName);
    const base: ChannelBase = { name, color, muted: !flChannel.enabled, solo: false };

    if (flChannel.type === FLP_CHANNEL_TYPE.layer) {
      this.layers.set(flChannel.iid, flChannel.children);
      this.ctx.report.layers.push({ channel: name, children: flChannel.children.length });
      return;
    }
    if (flChannel.type === FLP_CHANNEL_TYPE.automation || (flChannel.type === null && flChannel.automation)) {
      this.add(flChannel, automationChannel(flChannel, base));
      return;
    }
    const mix = readMix(flChannel, this.insertFor);
    if (isSamplerChannel(flChannel) && flChannel.type !== FLP_CHANNEL_TYPE.instrument) {
      this.addSamplerChannel(flChannel, base, mix);
      return;
    }
    this.addGeneratorChannel(flChannel, base, mix);
  }

  /** A sampler: FL's audio clip channel when it only plays as clips, else a sampler instrument. */
  private addSamplerChannel(flChannel: FlpChannel, base: ChannelBase, mix: ChannelMix): void {
    const ref = this.sampleFor(flChannel.samplePath, base.name);
    if (ref && this.inPlaylist.has(flChannel.iid) && !this.hasNotes.has(flChannel.iid)) {
      const channel: AudioClipChannel = {
        kind: 'audioClip',
        id: newId.channel(),
        ...base,
        volume: mix.volume,
        pan: mix.pan,
        output: mix.output,
        sampleId: ref.id,
        ...(mix.pitch ? { pitch: mix.pitch } : {}),
      };
      this.add(flChannel, channel);
      return;
    }
    const channel: InstrumentChannel = {
      kind: 'instrument',
      id: newId.channel(),
      ...base,
      volume: mix.volume,
      pan: mix.pan,
      output: mix.output,
      plugin: this.ctx.pluginInstance(FLP_PLUGIN.sampler, ref ? { samples: { main: ref.id } } : {}),
      rootKey: rootKeyOf(flChannel),
      ...(mix.pitch ? { pitch: mix.pitch } : {}),
    };
    this.add(flChannel, channel);
  }

  /** A generator plugin (or an instrument channel with a sample-less sampler) as a built-in instrument. */
  private addGeneratorChannel(flChannel: FlpChannel, base: ChannelBase, mix: ChannelMix): void {
    const { ctx } = this;
    let choice: PluginChoice = isSamplerChannel(flChannel)
      ? { pluginId: FLP_PLUGIN.sampler, standIn: false }
      : generatorChoice(flChannel, base.name);
    if (!ctx.opts.plugin(choice.pluginId)) choice = { pluginId: FLP_PLUGIN.threeOsc, standIn: true };

    const extra: Partial<PluginInstance> = {};
    if (choice.kit && kitPiece(choice.kit)) {
      const ref: SampleRef = {
        id: newId.sample(),
        name: kitPiece(choice.kit)?.name ?? choice.kit,
        source: { kind: 'builtin', generator: choice.kit, version: KIT_VERSION },
      };
      this.samples[ref.id] = ref;
      extra.samples = { main: ref.id };
    }
    const plugin = ctx.pluginInstance(choice.pluginId, extra);
    if (choice.params) {
      for (const [key, value] of Object.entries(choice.params)) if (key in plugin.params) plugin.params[key] = value;
    }
    let channelName = base.name;
    if (choice.standIn) {
      const flName = pluginLabel(flChannel);
      ctx.report.standIns.push({
        channel: base.name,
        plugin: flName,
        using: ctx.pluginName(choice.pluginId),
        vst: isVst(flChannel),
      });
      const sameName = flName.toLowerCase() === base.name.toLowerCase();
      channelName = sameName ? `${base.name} (stand-in)` : `${base.name} (stand-in for ${flName})`;
    }
    const channel: InstrumentChannel = {
      kind: 'instrument',
      id: newId.channel(),
      ...base,
      name: trimName(channelName),
      volume: mix.volume,
      pan: mix.pan,
      output: mix.output,
      plugin,
      // Kit stand-ins play their sound at the root key, so FL's notes (on any key) keep sounding.
      rootKey: rootKeyOf(flChannel),
      ...(mix.pitch ? { pitch: mix.pitch } : {}),
    };
    this.add(flChannel, channel);
  }

  /** Automation targets (FL keeps them apart from the clip): channel volume/pan. */
  private linkAutomationTargets(): void {
    const { flp, report } = this.ctx;
    for (const channel of this.channels) {
      if (channel.kind !== 'automation') continue;
      const iid = [...this.byIid].find(([, id]) => id === channel.id)?.[0];
      const link = flp.automationLinks.find((l) => l.channel === iid);
      let target: ParamTarget | null = null;
      if (link && (link.destination & AUTOMATION_LINK_NOT_A_CHANNEL) === 0) {
        const destinationId = this.byIid.get(link.destination);
        const destination = destinationId ? this.channels.find((c) => c.id === destinationId) : undefined;
        const param = link.param & AUTOMATION_LINK_PARAM_MASK;
        if (
          destination &&
          destination.kind !== 'automation' &&
          (param === LINK_PARAM_VOLUME || param === LINK_PARAM_PAN)
        ) {
          target = {
            kind: 'channel',
            channelId: destination.id,
            param: param === LINK_PARAM_VOLUME ? 'volume' : 'pan',
          };
        }
      }
      channel.target = target;
      if (!target) report.untargetedAutomation.push(channel.name);
    }
  }
}

/** Volume, pan, pitch and mixer track of an FL channel, in AGstudio's units. */
function readMix(flChannel: FlpChannel, insertFor: (flInsert: number | undefined) => InsertId): ChannelMix {
  return {
    volume:
      flChannel.volume !== undefined
        ? clamp(flChannel.volume / FL_CHANNEL_VOLUME_FULL, 0, CHANNEL_VOLUME_MAX)
        : DEFAULT_CHANNEL_VOLUME,
    pan:
      flChannel.pan !== undefined ? clamp((flChannel.pan - FL_CHANNEL_PAN_CENTER) / FL_CHANNEL_PAN_CENTER, -1, 1) : 0,
    pitch: flChannel.pitch ? clamp(Math.round(flChannel.pitch), -CHANNEL_PITCH_CENTS_MAX, CHANNEL_PITCH_CENTS_MAX) : 0,
    output: insertFor(flChannel.insert),
  };
}

function rootKeyOf(flChannel: FlpChannel): number {
  return clamp(Math.round(flChannel.rootNote ?? DEFAULT_ROOT_KEY), 0, MIDI_KEY_MAX);
}

/** An automation channel with its points (the target is linked later). */
function automationChannel(flChannel: FlpChannel, base: ChannelBase): AutomationChannel {
  return {
    kind: 'automation',
    id: newId.channel(),
    ...base,
    target: null,
    points: (flChannel.automation ?? [])
      .map((point) => ({
        tick: Math.max(0, Math.round(point.beats * PPQ)),
        value: clamp(point.value, 0, 1),
        ...(point.tension ? { tension: clamp(point.tension, -1, 1) } : {}),
      }))
      .sort((a, b) => a.tick - b.tick),
  };
}

/** A file name without its extension. */
const stemOf = (file: string): string => file.replace(/\.[^.]+$/, '');
