import type { Services } from '@app/services';
import type { ChannelId, InsertId, SlotId } from '@core/model/types';
import { fxSlotOf } from '@core/query/mixer';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { PluginWindow, type PluginWindowProps } from './PluginWindow';

export const order = 5;

function title(props: PluginWindowProps, s: Services): string {
  const p = s.doc.getState().project;
  if (props.kind === 'fx') {
    const insertId = props.insertId as InsertId;
    const slot = fxSlotOf(p, insertId, props.slotId as SlotId);
    const name = slot ? (s.plugins.get(slot.plugin.pluginId)?.name ?? 'missing plugin') : 'Effect';
    const index = p.mixer.order.indexOf(insertId);
    return `${name} — ${index === 0 ? 'Master' : index > 0 ? `Insert ${index}` : 'Mixer'}`;
  }
  const ch = p.channels[props.channelId as ChannelId];
  if (!ch || ch.kind !== 'instrument') return 'Plugin';
  const name = s.plugins.get(ch.plugin.pluginId)?.name ?? 'missing plugin';
  return ch.name === name ? name : `${ch.name} (${name})`;
}

export function register(services: Services): void {
  registerWindowType<PluginWindowProps>({
    type: 'plugin',
    title,
    component: PluginWindow,
    instanceId: (props) => (props.kind === 'fx' ? `plugin:fx:${props.slotId}` : `plugin:${props.channelId}`),
    defaultRect: (ws) => ({ x: Math.max(20, ws.w / 2 - 260), y: Math.max(20, ws.h / 2 - 210), w: 520, h: 400 }),
    minSize: { w: 300, h: 180 },
    cascade: true,
  });

  services.commands.register<{ channelId?: string } | undefined>({
    id: 'plugin.openEditor',
    title: 'Open plugin editor',
    category: 'Channels',
    hint: 'Open the selected channel’s instrument',
    enabled: (s) => !!s.session.getState().selectedChannelId,
    run: (s, args) => {
      const channelId = args?.channelId ?? s.session.getState().selectedChannelId;
      if (channelId) openWindow(s, 'plugin', { kind: 'channel', channelId });
    },
  });
  services.keymap.add([{ chord: 'Enter', command: 'plugin.openEditor', when: { focus: ['channel-rack'] } }]);
}
