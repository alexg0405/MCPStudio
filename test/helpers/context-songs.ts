/**
 * Synthetic songs for the AI context size budget (`src/app/ai/context.ts`): a song of N instrument
 * channels with patterns and a playlist, built through history like the other fixtures. Ids are
 * seeded so the context text is the same on every run.
 */
import type { Draft } from 'immer';
import type { ParamSpecs, ParamValue } from '@agstudio/sdk';
import { makeInstrumentChannel, makeLane, makePattern, makePluginInstance, paletteColor } from '@core/model/defaults';
import { newId, seededBytes, setIdSource } from '@core/model/ids';
import { MASTER, type ChannelId, type ClipId, type LaneId, type Note, type PatternId, type Project } from '@core/model/types';
import type { TestServices } from './focus';

const BAR = 3840;
const STEP = 240;
const PLUGINS = ['agstudio.wavetable', 'agstudio.pluck', 'agstudio.fm', 'agstudio.bass808'];

export interface SongShape {
  /** Instrument channels in the rack. */
  channels: number;
  /** The first `playing` channels have notes in the patterns; the rest play nowhere. */
  playing: number;
  patterns: number;
  /** Playlist tracks with clips. */
  tracks: number;
  /** Pattern clips per track (two bars each). */
  blocksPerTrack: number;
  markers: number;
  /** Non-default settings per channel. */
  settingsPerChannel: number;
  seed: number;
}

/** A 30-channel song: 22 channels play, 8 play nowhere. */
export const THIRTY_CHANNEL_SONG: SongShape = {
  channels: 30,
  playing: 22,
  patterns: 14,
  tracks: 12,
  blocksPerTrack: 8,
  markers: 6,
  settingsPerChannel: 4,
  seed: 3,
};

/** A 200-channel, 200-pattern project: 90 channels play, 110 play nowhere. */
export const TWO_HUNDRED_CHANNEL_SONG: SongShape = {
  channels: 200,
  playing: 90,
  patterns: 200,
  tracks: 32,
  blocksPerTrack: 16,
  markers: 12,
  settingsPerChannel: 4,
  seed: 5,
};

/** The same project with all 200 channels playing. */
export const TWO_HUNDRED_CHANNEL_ALL_PLAYING_SONG: SongShape = { ...TWO_HUNDRED_CHANNEL_SONG, playing: 200 };

/** A few settings per plugin, moved off their defaults (the first float/int/bool params). */
function someSettings(s: TestServices, pluginId: string, salt: number, count: number): Record<string, ParamValue> {
  const specs = (s.plugins.get(pluginId)?.params ?? {}) as ParamSpecs;
  const ids = Object.keys(specs);
  const out: Record<string, ParamValue> = {};
  if (ids.length === 0) return out;
  for (let k = 0; k < Math.min(count, ids.length); k++) {
    const id = ids[(salt * 3 + k) % ids.length]!;
    const spec = specs[id]!;
    if (spec.type === 'float' || spec.type === 'int') out[id] = spec.default === spec.max ? spec.min : spec.max;
    else if (spec.type === 'bool') out[id] = !spec.default;
  }
  return out;
}

/** Runs `fn` with seeded ids, then restores the random source. */
export function withSeededIds<T>(seed: number, fn: () => T): T {
  const prev = setIdSource(seededBytes(seed));
  try {
    return fn();
  } finally {
    setIdSource(prev);
  }
}

/** Fills the test services' project with a synthetic song of the given shape. */
export function buildSyntheticSong(s: TestServices, shape: SongShape): { channels: ChannelId[]; patterns: PatternId[] } {
  const pluginOf = (i: number) => PLUGINS[i % PLUGINS.length]!;
  const settings = Array.from({ length: shape.channels }, (_, i) => someSettings(s, pluginOf(i), i, shape.settingsPerChannel));
  let out!: { channels: ChannelId[]; patterns: PatternId[] };
  s.history.transact('synthetic song', (d: Draft<Project>) => {
    d.transport.bpm = 128;
    d.patterns = {} as never;
    d.patternOrder = [];
    d.playlist.clips = {} as never;
    d.playlist.markers = {} as never;
    d.playlist.lanes = {} as never;
    d.playlist.laneOrder = [];
    d.channels = {} as never;
    d.channelOrder = [];

    const channels: ChannelId[] = [];
    for (let i = 0; i < shape.channels; i++) {
      const plugin = makePluginInstance(pluginOf(i), 1, settings[i]!);
      const ch = makeInstrumentChannel(`${['Bass', 'Pad', 'Lead', 'Pluck'][i % 4]} ${i + 1}`, plugin, {
        color: paletteColor(i),
        output: MASTER,
      });
      d.channels[ch.id] = ch;
      d.channelOrder.push(ch.id);
      channels.push(ch.id);
    }

    const notes = (list: [step: number, key: number][]): Record<string, Note> =>
      Object.fromEntries(
        list.map(([step, key]) => {
          const id = newId.note();
          return [id, { id, tick: Math.round(step * STEP), length: STEP, key, velocity: 0.8 }];
        }),
      );
    const playing = channels.slice(0, shape.playing);
    const patterns: PatternId[] = [];
    for (let i = 0; i < shape.patterns; i++) {
      const pat = makePattern(`Loop ${i + 1}`, paletteColor(i));
      pat.length = 2 * BAR;
      pat.stepCount = 32;
      for (const k of [0, 3, 7]) {
        const ch = playing[(i * 7 + k * 13) % playing.length];
        if (!ch) continue;
        pat.notes[ch] = notes(Array.from({ length: 8 }, (_, j) => [(j * 4 + k + (i % 4)) % 32, 48 + ((i + j * 5 + k) % 24)] as [number, number]));
      }
      d.patterns[pat.id] = pat;
      d.patternOrder.push(pat.id);
      patterns.push(pat.id);
    }

    const laneIds: LaneId[] = [];
    for (let t = 1; t <= shape.tracks; t++) {
      const lane = makeLane(`Track ${t}`);
      d.playlist.lanes[lane.id] = lane;
      d.playlist.laneOrder.push(lane.id);
      laneIds.push(lane.id);
    }
    for (let t = 0; t < shape.tracks; t++) {
      for (let b = 0; b < shape.blocksPerTrack; b++) {
        const id = newId.clip() as ClipId;
        const pid = patterns[(t * 17 + b * 5) % patterns.length]!;
        d.playlist.clips[id] = {
          kind: 'pattern',
          id,
          laneId: laneIds[t]!,
          start: b * 2 * BAR,
          length: 2 * BAR,
          patternId: pid,
          offset: 0,
        };
      }
    }

    const every = Math.max(1, Math.floor((shape.blocksPerTrack * 2) / Math.max(1, shape.markers)));
    for (let m = 0; m < shape.markers; m++) {
      const id = newId.marker();
      d.playlist.markers[id] = { id, tick: m * every * BAR, name: `Section ${m + 1}` };
    }
    out = { channels, patterns };
  });
  return out;
}
