/**
 * A very big project for speed work: 200 sound channels (synths, samplers, audio clip channels, drum pads), 60
 * automation channels, 100 mixer tracks with 3 to 6 effects each, 500 patterns with 20,000+ notes, 2,000 playlist
 * clips over 300 bars, a chord track, lyrics, take groups and a few pitch and cleanup edits. `?perf=huge` loads it,
 * the speed tests and `scripts/perf-huge.mjs` measure on it.
 *
 * It is a made-up song, not a good one: what matters is the counts, so every part is generated from a seeded
 * `Rng` (the same project every time, apart from the ids, which a seeded id source makes repeatable too). Sounds are the
 * built-in kit and synths, and the "renders" of edited clips are other built-in samples, so nothing needs a file.
 */
import type { Draft } from 'immer';
import { Rng } from '@agstudio/sdk/dsp/random';
import {
  makeInsert,
  makeInstrumentChannel,
  makePluginInstance,
  paletteColor,
} from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { KIT, KIT_VERSION } from '@core/model/kit';
import {
  MASTER,
  type AudioClipChannel,
  type AutomationChannel,
  type ChannelId,
  type InsertId,
  type ParamTarget,
  type Project,
  type SampleId,
  type SlotId,
} from '@core/model/types';
import { addHugeArrangement, type HugeArrangement } from './huge-arrangement';

/** How big the fixture is. The defaults are the "huge" project; smaller numbers make a quick one for tests. */
export interface HugeSongSize {
  soundChannels: number;
  automationChannels: number;
  mixerTracks: number;
  patterns: number;
  /** Notes in the biggest pattern (the piano roll's "5,000 notes" case). */
  bigPatternNotes: number;
  /** Notes in all the other patterns together, about. */
  otherNotes: number;
  clips: number;
  bars: number;
  takeGroups: number;
}

/** The size the speed measurements use. */
export const HUGE_SIZE: Readonly<HugeSongSize> = {
  soundChannels: 200,
  automationChannels: 60,
  mixerTracks: 100,
  patterns: 500,
  bigPatternNotes: 5000,
  otherNotes: 16000,
  clips: 2000,
  bars: 300,
  takeGroups: 6,
};

/** A small version of the same shapes, for unit tests of the builder and of code that reads projects. */
export const SMALL_HUGE_SIZE: Readonly<HugeSongSize> = {
  soundChannels: 20,
  automationChannels: 6,
  mixerTracks: 10,
  patterns: 12,
  bigPatternNotes: 200,
  otherNotes: 300,
  clips: 80,
  bars: 24,
  takeGroups: 1,
};

/** The synths the instrument channels cycle through (all built in). */
const SYNTHS = ['agstudio.3xosc', 'agstudio.wavetable', 'agstudio.fm', 'agstudio.pluck', 'agstudio.bass808', 'agstudio.drum-synth'];
/** The effects the mixer tracks cycle through (all built in). */
const EFFECTS = [
  'agstudio.eq-pro',
  'agstudio.compressor',
  'agstudio.reverb',
  'agstudio.delay',
  'agstudio.chorus',
  'agstudio.saturator',
  'agstudio.stereo',
  'agstudio.limiter',
  'agstudio.multiband',
  'agstudio.phaser',
  'agstudio.filter',
  'agstudio.distortion',
];
/** Plugin ids the fixture uses, so a test can check that every one still exists. */
export const HUGE_PLUGIN_IDS: readonly string[] = [...SYNTHS, ...EFFECTS, 'agstudio.sampler', 'agstudio.drum-pads', 'agstudio.ducker'];

/** What kind of channel the n-th sound channel is: seven in ten play a plugin, two in ten audio clips, one in ten drum pads. */
type SoundKind = 'synth' | 'sampler' | 'audio' | 'pads';
const KIND_CYCLE: readonly SoundKind[] = ['synth', 'synth', 'synth', 'sampler', 'synth', 'audio', 'synth', 'pads', 'audio', 'synth'];

/** The parts of the project the arrangement is written against, by role. */
export interface HugeSong extends HugeArrangement {
  /** The channel that holds the big pattern's thousands of notes. */
  bigChannel: ChannelId;
}

/** Fills an empty project (from `createEmptyProject`) with the huge song. Returns the ids the callers need. */
export function buildHugeSong(d: Draft<Project>, size: Readonly<HugeSongSize> = HUGE_SIZE, seed = 20260): HugeSong {
  const rng = new Rng(seed);
  d.transport.bpm = 128;
  d.transport.key = { root: 9, scale: 'minor' };
  clearDefaults(d);
  const inserts = addMixer(d, size.mixerTracks, rng);
  const channels = addSoundChannels(d, size.soundChannels, inserts, rng);
  const automation = addAutomationChannels(d, size.automationChannels, channels, inserts, rng);
  const arrangement = addHugeArrangement(d, { size, channels, automation, rng });
  return { ...arrangement, bigChannel: channels.instruments[0] as ChannelId };
}

/** Takes away what `createEmptyProject` and the default kit brought: the 16 inserts, the pattern, the 32 tracks. */
function clearDefaults(d: Draft<Project>): void {
  d.channels = {} as never;
  d.channelOrder = [];
  d.patterns = {} as never;
  d.patternOrder = [];
  d.playlist.clips = {} as never;
  d.playlist.lanes = {} as never;
  d.playlist.laneOrder = [];
  const master = d.mixer.inserts[MASTER]!;
  d.mixer.inserts = { [MASTER]: master } as never;
  d.mixer.order = [MASTER];
}

/**
 * The mixer: `count` tracks. The first five sixths feed a bus (the last tracks), the buses feed the master, and a few
 * tracks also send to a second bus. Every track has 3 to 6 effects; some ducker slots listen to the first track.
 */
function addMixer(d: Draft<Project>, count: number, rng: Rng): InsertId[] {
  const inserts: InsertId[] = [];
  for (let i = 0; i < count; i++) {
    const id = newId.insert();
    d.mixer.inserts[id] = makeInsert(id, `Track ${i + 1}`);
    d.mixer.order.push(id);
    inserts.push(id);
  }
  const buses = Math.max(1, Math.round(count * 0.16));
  const firstBus = count - buses;
  inserts.forEach((id, i) => {
    const insert = d.mixer.inserts[id]!;
    insert.color = paletteColor(i);
    if (i < firstBus) insert.routes = [{ to: inserts[firstBus + (i % buses)] as InsertId, level: 1, pre: false }];
    const send = inserts[firstBus + ((i + 1) % buses)] as InsertId;
    if (i < firstBus && i % 5 === 0 && send !== insert.routes[0]?.to) insert.routes.push({ to: send, level: 0.3, pre: false });
    addEffects(d, insert.id, i, inserts[0] as InsertId, rng);
  });
  return inserts;
}

/** Three to six effects on one track, picked from the cycle starting at an offset that depends on the track. */
function addEffects(d: Draft<Project>, insertId: InsertId, index: number, sidechainSource: InsertId, rng: Rng): void {
  const insert = d.mixer.inserts[insertId]!;
  const count = 3 + ((index * 7 + Math.floor(rng.next() * 3)) % 4);
  for (let k = 0; k < count; k++) {
    const slot = {
      id: newId.slot() as SlotId,
      plugin: makePluginInstance(EFFECTS[(index * 3 + k) % EFFECTS.length] as string, 1, {}),
      enabled: !(index % 9 === 4 && k === 1),
      mix: 1,
      sidechain: null as InsertId | null,
    };
    insert.fx.push(slot);
  }
  if (index % 7 === 3 && insertId !== sidechainSource) {
    insert.fx.push({
      id: newId.slot() as SlotId,
      plugin: makePluginInstance('agstudio.ducker', 1, {}),
      enabled: true,
      mix: 1,
      sidechain: sidechainSource,
    });
  }
}

/** The channel ids by role, so the arrangement and the automation know what to point at. */
export interface HugeChannels {
  /** Instrument channels that play a plugin (synths, samplers, drum pads), in rack order. */
  instruments: ChannelId[];
  /** The ones among them that are drum pads (notes on keys 36 to 51). */
  drumPads: ChannelId[];
  /** The ones that are wavetable synths (automation drives their cutoff). */
  wavetables: ChannelId[];
  /** Audio clip channels, which the playlist's audio clips play through. */
  audio: ChannelId[];
  /** Channels that no pattern or clip uses and that are muted: the project's dead weight. */
  idle: ChannelId[];
}

/** The 200 sound channels: output tracks spread over the mixer, a few muted, one in eight left unused. */
function addSoundChannels(d: Draft<Project>, count: number, inserts: InsertId[], rng: Rng): HugeChannels {
  const found: HugeChannels = { instruments: [], drumPads: [], wavetables: [], audio: [], idle: [] };
  const sampleOf = (generator: string): SampleId => {
    const id = newId.sample();
    d.samples[id] = { id, name: generator.replace('kit/', ''), source: { kind: 'builtin', generator, version: KIT_VERSION } };
    return id;
  };
  const buses = Math.max(1, Math.round(inserts.length * 0.16));
  const sourceTracks = inserts.length - buses;
  for (let i = 0; i < count; i++) {
    const kind = KIND_CYCLE[i % KIND_CYCLE.length] as SoundKind;
    const output = inserts[(i * 3) % sourceTracks] as InsertId;
    const piece = KIT[i % KIT.length]!;
    const name = `${kind === 'pads' ? 'Pads' : kind === 'audio' ? 'Audio' : kind === 'sampler' ? piece.short : 'Synth'} ${i + 1}`;
    if (kind === 'audio') {
      const channel: AudioClipChannel = {
        kind: 'audioClip',
        id: newId.channel(),
        name,
        color: paletteColor(i),
        muted: false,
        solo: false,
        volume: 0.7,
        pan: 0,
        output,
        sampleId: sampleOf(piece.generator),
      };
      d.channels[channel.id] = channel;
      d.channelOrder.push(channel.id);
      found.audio.push(channel.id);
      continue;
    }
    const pluginId = kind === 'pads' ? 'agstudio.drum-pads' : kind === 'sampler' ? 'agstudio.sampler' : (SYNTHS[(i * 5) % SYNTHS.length] as string);
    const plugin = makePluginInstance(pluginId, 1, {});
    if (kind === 'sampler') plugin.samples = { main: sampleOf(piece.generator) };
    const channel = makeInstrumentChannel(name, plugin, { color: paletteColor(i), output });
    channel.volume = 0.55 + rng.next() * 0.3;
    channel.pan = Math.round((rng.next() - 0.5) * 100) / 100;
    d.channels[channel.id] = channel;
    d.channelOrder.push(channel.id);
    found.instruments.push(channel.id);
    if (kind === 'pads') found.drumPads.push(channel.id);
    if (pluginId === 'agstudio.wavetable') found.wavetables.push(channel.id);
    if (i % 8 === 7) {
      channel.muted = true;
      found.idle.push(channel.id);
    }
  }
  return found;
}

/** What an automation channel may drive, as targets picked from the channels and tracks that exist. */
function automationTargets(count: number, channels: HugeChannels, inserts: InsertId[], d: Draft<Project>): ParamTarget[] {
  const targets: ParamTarget[] = [];
  const pick = <T>(list: T[], i: number): T => list[i % list.length] as T;
  const played = channels.instruments.filter((id) => !channels.idle.includes(id));
  for (let i = 0; targets.length < count; i++) {
    const kind = i % 6;
    if (kind === 0) targets.push({ kind: 'channel', channelId: pick(played, i), param: 'volume' });
    else if (kind === 1) targets.push({ kind: 'channel', channelId: pick(played, i * 3), param: 'pan' });
    else if (kind === 2) targets.push({ kind: 'insert', insertId: pick(inserts, i * 5), param: 'volume' });
    else if (kind === 3) targets.push({ kind: 'insert', insertId: pick(inserts, i * 7), param: 'pan' });
    else if (kind === 4 && channels.wavetables.length) {
      const owner = { kind: 'channel' as const, channelId: pick(channels.wavetables, i) };
      targets.push({ kind: 'plugin', owner, paramId: 'cutoff' });
    } else {
      const insertId = pick(inserts, i * 11);
      const slot = d.mixer.inserts[insertId]?.fx[0];
      if (slot) targets.push({ kind: 'slot', insertId, slotId: slot.id, param: 'mix' });
      else targets.push({ kind: 'channel', channelId: pick(played, i * 13), param: 'volume' });
    }
  }
  return targets;
}

/** The automation channels (curves of three to five points): they take a rack row each, like in FL Studio. */
function addAutomationChannels(
  d: Draft<Project>,
  count: number,
  channels: HugeChannels,
  inserts: InsertId[],
  rng: Rng,
): ChannelId[] {
  const ids: ChannelId[] = [];
  const targets = automationTargets(count, channels, inserts, d);
  targets.forEach((target, i) => {
    const pointCount = 3 + (i % 3);
    const points = Array.from({ length: pointCount }, (_, k) => ({
      tick: Math.round((k * 4 * 3840) / (pointCount - 1)),
      value: Math.round(rng.next() * 100) / 100,
    }));
    const channel: AutomationChannel = {
      kind: 'automation',
      id: newId.channel(),
      name: `Automation ${i + 1}`,
      color: paletteColor(i + 3),
      muted: false,
      solo: false,
      target,
      points,
    };
    d.channels[channel.id] = channel;
    d.channelOrder.push(channel.id);
    ids.push(channel.id);
  });
  return ids;
}
