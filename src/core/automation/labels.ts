/**
 * Plain words for automation: what a target controls ("Cutoff · 3xOsc", "Volume · Insert 3",
 * "Tempo") and its values with units ("−6.0 dB", "128 BPM", "1.20 kHz", "25% L").
 */
import { decode, formatValue, type ParamSpecs } from '@agstudio/sdk/params';
import { formatGain } from '../model/fader';
import type { AutomationChannel, ParamTarget, Project } from '../model/types';
import { fxSlotOf, insertLabel } from '../query/mixer';
import type { ResolvedTarget } from './targets';

/** Name and param specs of a plugin by id (the app's registry; core can't see plugin definitions). */
export type PluginInfoResolver = (pluginId: string) => { name: string; params: ParamSpecs } | undefined;

const HOST = { volume: 'Volume', pan: 'Pan', pitch: 'Pitch' } as const;

/** What a target controls, in plain words; null when what it points at no longer exists. */
export function targetName(p: Project, t: ParamTarget, plugins: PluginInfoResolver): string | null {
  switch (t.kind) {
    case 'channel': {
      const ch = p.channels[t.channelId];
      return ch && ch.kind !== 'automation' ? `${HOST[t.param]} · ${ch.name}` : null;
    }
    case 'insert':
      return p.mixer.inserts[t.insertId] ? `${HOST[t.param]} · ${insertLabel(p, t.insertId)}` : null;
    case 'slot': {
      const slot = fxSlotOf(p, t.insertId, t.slotId);
      if (!slot) return null;
      const name = plugins(slot.plugin.pluginId)?.name ?? 'Effect';
      return `Mix · ${name} (${insertLabel(p, t.insertId)})`;
    }
    case 'route': {
      const ins = p.mixer.inserts[t.insertId];
      if (!ins?.routes.some((r) => r.to === t.to)) return null;
      return `Send · ${insertLabel(p, t.insertId)} → ${insertLabel(p, t.to)}`;
    }
    case 'vca': {
      const group = p.mixer.groups?.find((g) => g.id === t.groupId);
      return group?.vca === undefined ? null : `VCA · ${group.name}`;
    }
    case 'plugin': {
      if (t.owner.kind === 'channel') {
        const ch = p.channels[t.owner.channelId];
        if (!ch || ch.kind !== 'instrument') return null;
        const spec = plugins(ch.plugin.pluginId)?.params[t.paramId];
        return `${spec?.label ?? t.paramId} · ${ch.name}`;
      }
      const slot = fxSlotOf(p, t.owner.insertId, t.owner.slotId);
      if (!slot) return null;
      const info = plugins(slot.plugin.pluginId);
      const spec = info?.params[t.paramId];
      return `${spec?.label ?? t.paramId} · ${info?.name ?? 'Effect'} (${insertLabel(p, t.owner.insertId)})`;
    }
    case 'tempo':
      return 'Tempo';
  }
}

/** The label an automation clip shows: what it drives, or why it drives nothing. */
export function automationLabel(p: Project, ch: AutomationChannel, plugins: PluginInfoResolver): string {
  if (!ch.target) return `${ch.name} (drives nothing)`;
  return targetName(p, ch.target, plugins) ?? `${ch.name} (target deleted)`;
}

const trim = (v: number, digits: number) => String(Number(v.toFixed(digits)));

/** A value of the target in its units, from a normalized curve value. */
export function formatAutomationValue(res: ResolvedTarget, target: ParamTarget, n: number): string {
  const v = res.fromNormalized(n);
  switch (target.kind) {
    case 'tempo':
      return `${trim(v, 1)} BPM`;
    case 'route':
    case 'vca':
      return formatGain(v);
    case 'channel':
    case 'insert':
      if (target.param === 'volume') return formatGain(v);
      if (target.param === 'pan') {
        const pct = Math.round(Math.abs(v) * 100);
        return pct === 0 ? 'Center' : `${pct}% ${v < 0 ? 'L' : 'R'}`;
      }
      break;
    default:
      break;
  }
  return formatValue(res.spec, decode(res.spec, v));
}
