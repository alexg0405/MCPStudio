import type { ParamValue } from '@agstudio/sdk/params';
import { newId } from './ids';
import {
  MASTER,
  SCHEMA_VERSION,
  type ChannelId,
  type Insert,
  type InsertId,
  type InstrumentChannel,
  type Lane,
  type LaneId,
  type Pattern,
  type PatternId,
  type PluginInstance,
  type Project,
} from './types';

/** The app version a new project stamps into its metadata (`meta.appVersion`). */
export const APP_VERSION = '0.1.0';
/** Tempo of a new project, in beats per minute. */
export const DEFAULT_BPM = 130;
/** Volume of a new channel as a linear gain (0..1.25, so 0.78 sits a little below the middle of the fader). */
export const DEFAULT_CHANNEL_VOLUME = 0.78;
/**
 * The MIDI note a new instrument channel treats as its root, for step notes and a sampler's original pitch (60 = FL's
 * C5).
 */
export const DEFAULT_ROOT_KEY = 60;
/** How many mixer inserts a new project has besides the master. */
export const DEFAULT_INSERTS = 16;
/** How many playlist tracks (lanes) a new project has. */
export const DEFAULT_LANES = 32;

/** FL-ish palette for channels, patterns and clips. */
export const PALETTE = [
  '#5f8fbf',
  '#6aa86b',
  '#c9a24a',
  '#c76b5b',
  '#9a72c2',
  '#4fa6a6',
  '#c77fa8',
  '#8c9a5b',
  '#c48a4f',
  '#6f7fd1',
];

/** The palette colour for a position; wraps around, so any whole number (negative too) gives a colour. */
export function paletteColor(index: number): string {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? '#5f8fbf';
}

/** A new insert: unity gain, no effects, routed to the master (the master itself routes nowhere). */
export function makeInsert(id: InsertId, name: string): Insert {
  return { id, name, volume: 1, pan: 0, muted: false, solo: false, fx: [], routes: masterRoutes(id) };
}

/** The default routing of an insert: the master, post-fader at unity. */
export function masterRoutes(id: InsertId): Insert['routes'] {
  return id === MASTER ? [] : [{ to: MASTER, level: 1, pre: false }];
}

/** A new empty pattern of 16 steps, with a fresh id unless one is given. */
export function makePattern(name: string, color: string, id: PatternId = newId.pattern()): Pattern {
  return { id, name, color, stepCount: 16, notes: {} };
}

/** A new unmuted playlist track, with a fresh id unless one is given. */
export function makeLane(name: string, id: LaneId = newId.lane()): Lane {
  return { id, name, muted: false };
}

/**
 * The saved settings of a plugin: which plugin and version, a copy of its parameter values, and optionally its state
 * and samples.
 */
export function makePluginInstance(
  pluginId: string,
  pluginVersion: number,
  params: Record<string, ParamValue>,
  extra: Pick<PluginInstance, 'state' | 'samples'> = {},
): PluginInstance {
  return { pluginId, pluginVersion, params: { ...params }, ...extra };
}

/**
 * A new unmuted instrument channel at the default volume, centred, routed to the master unless `opts.output` says
 * otherwise.
 */
export function makeInstrumentChannel(
  name: string,
  plugin: PluginInstance,
  opts: { color?: string; id?: ChannelId; output?: InsertId; rootKey?: number } = {},
): InstrumentChannel {
  return {
    kind: 'instrument',
    id: opts.id ?? newId.channel(),
    name,
    color: opts.color ?? PALETTE[0] ?? '#5f8fbf',
    muted: false,
    solo: false,
    volume: DEFAULT_CHANNEL_VOLUME,
    pan: 0,
    output: opts.output ?? MASTER,
    plugin,
    rootKey: opts.rootKey ?? DEFAULT_ROOT_KEY,
  };
}

/** A project with one empty pattern, master + inserts and playlist lanes, but no channels. */
export function createEmptyProject(opts: { title?: string; now?: Date } = {}): Project {
  const pattern = makePattern('Pattern 1', paletteColor(0));
  const inserts: Record<InsertId, Insert> = { [MASTER]: makeInsert(MASTER, 'Master') };
  const order: InsertId[] = [MASTER];
  for (let i = 1; i <= DEFAULT_INSERTS; i++) {
    const id = newId.insert();
    inserts[id] = makeInsert(id, `Insert ${i}`);
    order.push(id);
  }
  const lanes: Record<LaneId, Lane> = {};
  const laneOrder: LaneId[] = [];
  for (let i = 1; i <= DEFAULT_LANES; i++) {
    const lane = makeLane(`Track ${i}`);
    lanes[lane.id] = lane;
    laneOrder.push(lane.id);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: newId.project(),
    meta: {
      title: opts.title ?? 'Untitled',
      createdAt: (opts.now ?? new Date()).toISOString(),
      appVersion: APP_VERSION,
    },
    transport: { bpm: DEFAULT_BPM, timeSig: { num: 4, den: 4 }, swing: 0 },
    channels: {},
    channelOrder: [],
    patterns: { [pattern.id]: pattern },
    patternOrder: [pattern.id],
    playlist: { lanes, laneOrder, clips: {}, markers: {} },
    mixer: { inserts, order },
    samples: {},
    controllers: {},
  };
}
