/**
 * Right-click menus for controls that drive a ParamTarget (plugin knobs, channel and mixer knobs,
 * the tempo). Features add entries ("Create automation clip", "Link to controller…") with
 * addParamMenuItems; showParamMenu builds the menu for one control.
 */
import type { Services } from '@app/services';
import {
  CHANNEL_PAN_SPEC,
  CHANNEL_PITCH_SPEC,
  CHANNEL_VOLUME_SPEC,
  INSERT_PAN_SPEC,
  INSERT_VOLUME_SPEC,
  ROUTE_LEVEL_SPEC,
  SLOT_MIX_SPEC,
  TEMPO_SPEC,
  VCA_SPEC,
} from '@core/model/target-specs';
import type { ParamTarget } from '@core/model/types';
import { fxSlotOf, insertLabel, pluginInstanceOf } from '@core/query/mixer';
import type { ParamSpec } from '@agstudio/sdk';
import { showContextMenu, type MenuEntry } from './controls/ContextMenu';

export interface ParamMenuInfo {
  target: ParamTarget;
  spec: ParamSpec;
  /** What the menu is about, e.g. "3xOsc · Cutoff". */
  label: string;
  /** Resets the control to its default (one undoable edit). */
  reset?(): void;
}

export type ParamMenuProvider = (info: ParamMenuInfo, s: Services) => MenuEntry[];

const providers: ParamMenuProvider[] = [];

export function addParamMenuItems(provider: ParamMenuProvider): () => void {
  providers.push(provider);
  return () => {
    const i = providers.indexOf(provider);
    if (i >= 0) providers.splice(i, 1);
  };
}

/** The menu for one control: a header, each feature's entries (grouped), then Reset. */
export function paramMenuEntries(info: ParamMenuInfo, s: Services): MenuEntry[] {
  const out: MenuEntry[] = [{ kind: 'label', label: info.label }];
  for (const p of providers) {
    const entries = p(info, s);
    if (entries.length === 0) continue;
    if (out.length > 1) out.push({ kind: 'separator' });
    out.push(...entries);
  }
  if (info.reset) {
    if (out.length > 1) out.push({ kind: 'separator' });
    out.push({ label: 'Reset to default', onSelect: info.reset });
  }
  return out;
}

export function showParamMenu(at: { clientX: number; clientY: number }, info: ParamMenuInfo, s: Services): void {
  showContextMenu(at, paramMenuEntries(info, s));
}

/** Spec and label for a target, from the document and the plugin registry (null when it's gone). */
export function paramInfoFor(s: Services, target: ParamTarget): ParamMenuInfo | null {
  const p = s.doc.getState().project;
  switch (target.kind) {
    case 'channel': {
      const ch = p.channels[target.channelId];
      if (!ch || ch.kind === 'automation') return null;
      const spec =
        target.param === 'volume'
          ? CHANNEL_VOLUME_SPEC
          : target.param === 'pan'
            ? CHANNEL_PAN_SPEC
            : CHANNEL_PITCH_SPEC;
      return { target, spec, label: `${ch.name} · ${spec.label}` };
    }
    case 'insert': {
      if (!p.mixer.inserts[target.insertId]) return null;
      const spec = target.param === 'volume' ? INSERT_VOLUME_SPEC : INSERT_PAN_SPEC;
      return { target, spec, label: `${insertLabel(p, target.insertId)} · ${spec.label}` };
    }
    case 'slot': {
      const slot = fxSlotOf(p, target.insertId, target.slotId);
      if (!slot) return null;
      const name = s.plugins.get(slot.plugin.pluginId)?.name ?? slot.plugin.pluginId;
      return { target, spec: SLOT_MIX_SPEC, label: `${insertLabel(p, target.insertId)} · ${name} mix` };
    }
    case 'route': {
      if (!p.mixer.inserts[target.insertId]?.routes.some((r) => r.to === target.to)) return null;
      return {
        target,
        spec: ROUTE_LEVEL_SPEC,
        label: `${insertLabel(p, target.insertId)} → ${insertLabel(p, target.to)}`,
      };
    }
    case 'vca': {
      const group = p.mixer.groups?.find((g) => g.id === target.groupId);
      if (group?.vca === undefined) return null;
      return { target, spec: VCA_SPEC, label: `VCA · ${group.name}` };
    }
    case 'plugin': {
      const inst = pluginInstanceOf(p, target.owner);
      const def = inst ? s.plugins.get(inst.pluginId) : undefined;
      const spec = def?.params[target.paramId] as ParamSpec | undefined;
      if (!def || !spec) return null;
      return { target, spec, label: `${def.name} · ${spec.label ?? target.paramId}` };
    }
    case 'tempo':
      return { target, spec: TEMPO_SPEC, label: 'Tempo' };
  }
}
