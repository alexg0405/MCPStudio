/**
 * Which automatable targets a document change moved (a knob drag, a fader, a typed tempo…), read
 * from its Immer patches. Automation recording and "touch" (automation lets go of a control while
 * it is being moved) both start from this.
 */
import type { Patch } from 'immer';
import { targetKey } from '../model/targets';
import type { ChannelId, InsertId, ParamTarget, PluginInstance, PluginOwner, Project } from '../model/types';
import { pluginInstanceOf } from '../query/mixer';

/** Params of a plugin instance whose values differ between two versions of it. */
function changedParams(a: PluginInstance | undefined, b: PluginInstance | undefined): string[] {
  if (!a || !b || a === b || a.pluginId !== b.pluginId) return [];
  if (a.params === b.params) return [];
  const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)]);
  return [...keys].filter((k) => a.params[k] !== b.params[k]);
}

/**
 * Targets whose values changed from `prev` to `next`, judged from the patch paths (a whole replaced
 * channel or plugin compares its params). Each target appears once.
 */
export function targetsChangedBy(prev: Project, next: Project, patches: readonly Patch[] | null): ParamTarget[] {
  const out = new Map<string, ParamTarget>();
  const add = (t: ParamTarget) => out.set(targetKey(t), t);
  const plugin = (owner: PluginOwner) => {
    for (const paramId of changedParams(pluginInstanceOf(prev, owner), pluginInstanceOf(next, owner)))
      add({ kind: 'plugin', owner, paramId });
  };
  for (const patch of patches ?? []) {
    const path = patch.path;
    if (path[0] === 'transport' && (path[1] === 'bpm' || path.length === 1)) {
      if (prev.transport.bpm !== next.transport.bpm) add({ kind: 'tempo' });
    } else if (path[0] === 'channels' && typeof path[1] === 'string') {
      const channelId = path[1] as ChannelId;
      const a = prev.channels[channelId];
      const b = next.channels[channelId];
      if (!a || !b || b.kind === 'automation' || a.kind === 'automation') continue;
      const field = path[2];
      for (const param of ['volume', 'pan', 'pitch'] as const) {
        if (field !== undefined && field !== param) continue;
        const va = param === 'pitch' ? (a.kind === 'instrument' ? (a.pitch ?? 0) : 0) : a[param];
        const vb = param === 'pitch' ? (b.kind === 'instrument' ? (b.pitch ?? 0) : 0) : b[param];
        if (va !== vb) add({ kind: 'channel', channelId, param });
      }
      if (field === undefined || field === 'plugin') plugin({ kind: 'channel', channelId });
    } else if (path[0] === 'mixer' && path[1] === 'inserts' && typeof path[2] === 'string') {
      const insertId = path[2] as InsertId;
      const a = prev.mixer.inserts[insertId];
      const b = next.mixer.inserts[insertId];
      if (!a || !b) continue;
      const field = path[3];
      if ((field === undefined || field === 'volume') && a.volume !== b.volume)
        add({ kind: 'insert', insertId, param: 'volume' });
      if ((field === undefined || field === 'pan') && a.pan !== b.pan) add({ kind: 'insert', insertId, param: 'pan' });
      if (field === undefined || field === 'fx') {
        for (const slot of b.fx) {
          const old = a.fx.find((s) => s.id === slot.id);
          if (!old || old === slot) continue;
          if (old.mix !== slot.mix) add({ kind: 'slot', insertId, slotId: slot.id, param: 'mix' });
          plugin({ kind: 'fx', insertId, slotId: slot.id });
        }
      }
      if (field === undefined || field === 'routes') {
        for (const r of b.routes) {
          const old = a.routes.find((x) => x.to === r.to);
          if (old && old.level !== r.level) add({ kind: 'route', insertId, to: r.to });
        }
      }
    }
  }
  return [...out.values()];
}
