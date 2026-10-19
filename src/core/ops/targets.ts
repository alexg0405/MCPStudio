import type { Draft } from 'immer';
import type { ParamValue } from '@agstudio/sdk/params';
import type { ParamTarget, Project } from '../model/types';
import { setChannelProp, setPluginParam } from './channels';
import { setFxSlotMix, setInsertProp } from './mixer';
import { setVcaLevel } from './groups';
import { setBpm } from './notes';
import { setRouteLevel } from './routing';

/**
 * Sets what a target controls to a plain value (the units of its spec: linear gain for volumes and
 * sends, −1…1 pan, cents, BPM, or a plugin param value). Used by MIDI controller links, automation
 * recording and the AI. Targets that no longer exist are ignored.
 */
export function setTargetValue(d: Draft<Project>, t: ParamTarget, value: ParamValue): void {
  const n = typeof value === 'number' ? value : Number(value);
  switch (t.kind) {
    case 'channel': {
      if (t.param === 'pitch') {
        const ch = d.channels[t.channelId];
        if (ch?.kind === 'instrument' && Number.isFinite(n)) ch.pitch = Math.max(-2400, Math.min(2400, n));
        return;
      }
      if (Number.isFinite(n)) setChannelProp(d, t.channelId, t.param, n);
      return;
    }
    case 'insert':
      if (Number.isFinite(n)) setInsertProp(d, t.insertId, t.param, n);
      return;
    case 'slot':
      if (Number.isFinite(n)) setFxSlotMix(d, t.insertId, t.slotId, n);
      return;
    case 'route':
      if (Number.isFinite(n)) setRouteLevel(d, t.insertId, t.to, n);
      return;
    case 'vca':
      if (Number.isFinite(n)) setVcaLevel(d, t.groupId, n);
      return;
    case 'plugin':
      setPluginParam(d, t.owner, t.paramId, value);
      return;
    case 'tempo':
      if (Number.isFinite(n)) setBpm(d, n);
      return;
  }
}
