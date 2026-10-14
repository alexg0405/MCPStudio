import type { Draft } from 'immer';
import type { ParamValue } from '@agstudio/sdk/params';
import { clipChannelId } from '../model/clips';
import type { Json } from '../model/json';
import { targetUsesChannel } from '../model/targets';
import {
  MASTER,
  type Channel,
  type ChannelId,
  type InsertId,
  type ParamTarget,
  type PluginOwner,
  type Project,
  type SampleId,
  type SampleRef,
} from '../model/types';

// Pure draft mutators. Call them inside history.transact()/gesture() recipes.

export function addChannel(d: Draft<Project>, channel: Channel, index?: number): void {
  d.channels[channel.id] = channel as Draft<Channel>;
  const at = index === undefined ? d.channelOrder.length : Math.max(0, Math.min(index, d.channelOrder.length));
  d.channelOrder.splice(at, 0, channel.id);
}

/** Removes a channel and everything that references it (its notes, clips and controller links). */
export function removeChannel(d: Draft<Project>, id: ChannelId): void {
  if (!d.channels[id]) return;
  delete d.channels[id];
  const i = d.channelOrder.indexOf(id);
  if (i >= 0) d.channelOrder.splice(i, 1);
  for (const pid of d.patternOrder) {
    const pattern = d.patterns[pid];
    if (pattern && pattern.notes[id]) delete pattern.notes[id];
  }
  for (const [clipId, clip] of Object.entries(d.playlist.clips)) {
    if (clipChannelId(clip) === id) delete d.playlist.clips[clipId as keyof typeof d.playlist.clips];
  }
  // Frozen copies of it stay as ordinary audio.
  for (const ch of Object.values(d.channels)) if (ch.kind === 'audioClip' && ch.frozenFrom === id) delete ch.frozenFrom;
  dropControllers(d, (t) => targetUsesChannel(t, id));
}

/** Removes the controller links whose target matches. */
export function dropControllers(d: Draft<Project>, matches: (t: ParamTarget) => boolean): void {
  for (const [id, link] of Object.entries(d.controllers)) {
    if (matches(link.target)) delete d.controllers[id as keyof typeof d.controllers];
  }
}

export function moveChannel(d: Draft<Project>, id: ChannelId, toIndex: number): void {
  const from = d.channelOrder.indexOf(id);
  if (from < 0) return;
  d.channelOrder.splice(from, 1);
  d.channelOrder.splice(Math.max(0, Math.min(toIndex, d.channelOrder.length)), 0, id);
}

export type ChannelProp = 'name' | 'color' | 'volume' | 'pan' | 'muted' | 'solo' | 'output' | 'rootKey';
type ChannelPropValue = {
  name: string;
  color: string;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  output: InsertId;
  rootKey: number;
};

export function setChannelProp<K extends ChannelProp>(
  d: Draft<Project>,
  id: ChannelId,
  prop: K,
  value: ChannelPropValue[K],
): void {
  const ch = d.channels[id];
  if (!ch) return;
  switch (prop) {
    case 'volume':
      if (ch.kind !== 'automation') ch.volume = clamp(value as number, 0, 1.25);
      return;
    case 'pan':
      if (ch.kind !== 'automation') ch.pan = clamp(value as number, -1, 1);
      return;
    case 'output':
      if (ch.kind !== 'automation') ch.output = value as InsertId;
      return;
    case 'rootKey':
      if (ch.kind === 'instrument') ch.rootKey = Math.round(clamp(value as number, 0, 127));
      return;
    case 'name':
      ch.name = String(value).slice(0, 64) || ch.name;
      return;
    case 'color':
      ch.color = String(value);
      return;
    case 'muted':
      ch.muted = Boolean(value);
      return;
    case 'solo':
      ch.solo = Boolean(value);
      return;
  }
}

/**
 * FL-style solo: soloing a channel mutes every other channel; soloing the already-solo channel
 * un-solos everything.
 */
export function toggleSoloChannel(d: Draft<Project>, id: ChannelId): void {
  const target = d.channels[id];
  if (!target) return;
  const wasOnlySolo = target.solo && d.channelOrder.every((cid) => cid === id || !d.channels[cid]?.solo);
  for (const cid of d.channelOrder) {
    const ch = d.channels[cid];
    if (!ch) continue;
    ch.solo = wasOnlySolo ? false : cid === id;
    if (cid === id && !wasOnlySolo) ch.muted = false;
  }
}

function pluginOf(d: Draft<Project>, owner: PluginOwner) {
  if (owner.kind === 'channel') {
    const ch = d.channels[owner.channelId];
    return ch?.kind === 'instrument' ? ch.plugin : undefined;
  }
  return d.mixer.inserts[owner.insertId]?.fx.find((s) => s.id === owner.slotId)?.plugin;
}

export function setPluginParam(d: Draft<Project>, owner: PluginOwner, paramId: string, value: ParamValue): void {
  const plugin = pluginOf(d, owner);
  if (plugin) plugin.params[paramId] = value;
}

export function setPluginParams(d: Draft<Project>, owner: PluginOwner, values: Record<string, ParamValue>): void {
  const plugin = pluginOf(d, owner);
  if (!plugin) return;
  for (const [k, v] of Object.entries(values)) plugin.params[k] = v;
}

export function setPluginState(d: Draft<Project>, owner: PluginOwner, state: Json): void {
  const plugin = pluginOf(d, owner);
  if (plugin) plugin.state = state as Draft<Json>;
}

export function setPluginSample(d: Draft<Project>, owner: PluginOwner, slot: string, sampleId: SampleId | null): void {
  const plugin = pluginOf(d, owner);
  if (!plugin) return;
  if (sampleId === null) {
    if (plugin.samples) delete plugin.samples[slot];
    return;
  }
  plugin.samples = { ...(plugin.samples ?? {}), [slot]: sampleId };
}

export function addSample(d: Draft<Project>, sample: SampleRef): void {
  d.samples[sample.id] = sample as Draft<SampleRef>;
}

/** Routes every channel that pointed at `insertId` back to the master. */
export function retargetChannels(d: Draft<Project>, insertId: InsertId): void {
  for (const cid of d.channelOrder) {
    const ch = d.channels[cid];
    if (ch && ch.kind !== 'automation' && ch.output === insertId) ch.output = MASTER;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}
