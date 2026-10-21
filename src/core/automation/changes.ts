/**
 * Which automatable targets a document change moved (a knob drag, a fader, a typed tempo…), read
 * from its Immer patches. Automation recording and "touch" (automation lets go of a control while
 * it is being moved) both start from this.
 */
import type { Patch } from 'immer';
import { targetKey } from '../model/targets';
import type { ChannelId, InsertId, ParamTarget, PluginInstance, PluginOwner, Project } from '../model/types';
import { pluginInstanceOf } from '../query/mixer';
import { allSlots, locateSlot } from '../query/rack';

/** Params of a plugin instance whose values differ between two versions of it. */
function changedParams(a: PluginInstance | undefined, b: PluginInstance | undefined): string[] {
  if (!a || !b || a === b || a.pluginId !== b.pluginId) return [];
  if (a.params === b.params) return [];
  const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)]);
  return [...keys].filter((k) => a.params[k] !== b.params[k]);
}

/** The moved targets found so far, each once (by its key), and the two versions they are found between. */
class MovedTargets {
  private readonly found = new Map<string, ParamTarget>();

  constructor(
    readonly prev: Project,
    readonly next: Project,
  ) {}

  add(target: ParamTarget): void {
    this.found.set(targetKey(target), target);
  }

  /** Adds every param of a plugin whose value differs between the two versions. */
  addPluginParams(owner: PluginOwner): void {
    for (const paramId of changedParams(pluginInstanceOf(this.prev, owner), pluginInstanceOf(this.next, owner))) {
      this.add({ kind: 'plugin', owner, paramId });
    }
  }

  list(): ParamTarget[] {
    return [...this.found.values()];
  }
}

/** A channel's pitch offset in semitones (only instruments have one). */
const pitchOf = (channel: Project['channels'][ChannelId]): number =>
  channel?.kind === 'instrument' ? (channel.pitch ?? 0) : 0;

/** What a patch under `channels/<id>` moved: its volume, pan or pitch, or its plugin's params (`field` narrows it to one). */
function channelChanges(moved: MovedTargets, channelId: ChannelId, field: string | number | undefined): void {
  const a = moved.prev.channels[channelId];
  const b = moved.next.channels[channelId];
  if (!a || !b || b.kind === 'automation' || a.kind === 'automation') return;
  for (const param of ['volume', 'pan', 'pitch'] as const) {
    if (field !== undefined && field !== param) continue;
    const before = param === 'pitch' ? pitchOf(a) : a[param];
    const after = param === 'pitch' ? pitchOf(b) : b[param];
    if (before !== after) moved.add({ kind: 'channel', channelId, param });
  }
  if (field === undefined || field === 'plugin') moved.addPluginParams({ kind: 'channel', channelId });
}

/** What a patch under `mixer/inserts/<id>` moved: its volume or pan, an effect's mix or params, a route's level. */
function insertChanges(moved: MovedTargets, insertId: InsertId, field: string | number | undefined): void {
  const a = moved.prev.mixer.inserts[insertId];
  const b = moved.next.mixer.inserts[insertId];
  if (!a || !b) return;
  if ((field === undefined || field === 'volume') && a.volume !== b.volume) {
    moved.add({ kind: 'insert', insertId, param: 'volume' });
  }
  if ((field === undefined || field === 'pan') && a.pan !== b.pan)
    moved.add({ kind: 'insert', insertId, param: 'pan' });
  if (field === undefined || field === 'fx') {
    // Effects inside racks count too: each has an id of its own on the insert.
    for (const slot of allSlots(b)) {
      const old = locateSlot(a, slot.id)?.slot;
      if (!old || old === slot) continue;
      if (old.mix !== slot.mix) moved.add({ kind: 'slot', insertId, slotId: slot.id, param: 'mix' });
      moved.addPluginParams({ kind: 'fx', insertId, slotId: slot.id });
    }
  }
  if (field === undefined || field === 'routes') {
    for (const r of b.routes) {
      const old = a.routes.find((x) => x.to === r.to);
      if (old && old.level !== r.level) moved.add({ kind: 'route', insertId, to: r.to });
    }
  }
}

/** What a patch under `mixer/groups` moved: the VCA level of a group whose level differs. */
function groupChanges(moved: MovedTargets): void {
  for (const group of moved.next.mixer.groups ?? []) {
    const old = moved.prev.mixer.groups?.find((g) => g.id === group.id);
    if (old && old.vca !== group.vca && group.vca !== undefined) moved.add({ kind: 'vca', groupId: group.id });
  }
}

/**
 * Targets whose values changed from `prev` to `next`, judged from the patch paths (a whole replaced
 * channel or plugin compares its params). Each target appears once.
 */
export function targetsChangedBy(prev: Project, next: Project, patches: readonly Patch[] | null): ParamTarget[] {
  const moved = new MovedTargets(prev, next);
  for (const patch of patches ?? []) {
    const path = patch.path;
    if (path[0] === 'transport' && (path[1] === 'bpm' || path.length === 1)) {
      if (prev.transport.bpm !== next.transport.bpm) moved.add({ kind: 'tempo' });
    } else if (path[0] === 'channels' && typeof path[1] === 'string') {
      channelChanges(moved, path[1] as ChannelId, path[2]);
    } else if (path[0] === 'mixer' && path[1] === 'inserts' && typeof path[2] === 'string') {
      insertChanges(moved, path[2] as InsertId, path[3]);
    } else if (path[0] === 'mixer' && path[1] === 'groups') {
      groupChanges(moved);
    }
  }
  return moved.list();
}
