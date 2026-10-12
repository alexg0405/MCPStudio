import type { Services } from '@app/services';
import type { ChannelId } from '@core/model/types';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { PluginWindow, type PluginWindowProps } from './PluginWindow';

export const order = 5;

export function register(services: Services): void {
  registerWindowType<PluginWindowProps>({
    type: 'plugin',
    title: (props, s) => {
      const p = s.doc.getState().project;
      const ch = p.channels[props.channelId as ChannelId];
      if (!ch || ch.kind !== 'instrument') return 'Plugin';
      const name = s.plugins.get(ch.plugin.pluginId)?.name ?? 'missing plugin';
      return ch.name === name ? name : `${ch.name} (${name})`;
    },
    component: PluginWindow,
    instanceId: (props) => `plugin:${props.channelId}`,
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
