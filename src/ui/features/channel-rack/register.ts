import type { Services } from '@app/services';
import { addChannelMenu, ChannelRack } from './ChannelRack';
import { deleteChannel } from '@app/actions/channels';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { addMenuItems, cmd } from '../../shell/menus';
import { showContextMenu } from '../../controls/ContextMenu';

export function register(services: Services): void {
  registerWindowType({
    type: 'channel-rack',
    title: () => 'Channel rack',
    component: ChannelRack,
    defaultRect: (ws) => ({ x: 48, y: 36, w: Math.min(640, ws.w - 96), h: 300 }),
    minSize: { w: 420, h: 160 },
  });
  registerWindowToggle(services, {
    command: 'view.channelRack',
    type: 'channel-rack',
    title: 'Channel rack',
    hint: 'Show or hide the channel rack',
    chords: ['F6', 'Alt+2'],
    menuOrder: 20,
  });

  const { commands, keymap } = services;
  const selected = (s: Services) => s.session.getState().selectedChannelId;

  commands.register({
    id: 'channels.add',
    title: 'Channel…',
    category: 'Channels',
    hint: 'Add a kit sound or instrument channel',
    run: (s) => showContextMenu({ x: window.innerWidth / 3, y: 80 }, addChannelMenu(s)),
  });
  commands.register({
    id: 'channels.delete',
    title: 'Delete selected channel',
    category: 'Channels',
    enabled: (s) => !!selected(s),
    run: (s) => {
      const id = selected(s);
      if (id) deleteChannel(s, id);
    },
  });
  const step = (delta: number) => (s: Services) => {
    const order = s.doc.getState().project.channelOrder;
    const i = order.indexOf(selected(s) ?? order[0]!);
    const next = order[Math.max(0, Math.min(order.length - 1, i + delta))];
    if (next) s.session.getState().selectChannel(next);
  };
  commands.register({
    id: 'channels.selectPrev',
    title: 'Select previous channel',
    category: 'Channels',
    run: step(-1),
  });
  commands.register({ id: 'channels.selectNext', title: 'Select next channel', category: 'Channels', run: step(1) });

  keymap.add([
    { chord: 'Alt+Delete', command: 'channels.delete', when: { focus: ['channel-rack'] } },
    { chord: 'Alt+Backspace', command: 'channels.delete', when: { focus: ['channel-rack'] } },
    { chord: 'ArrowUp', command: 'channels.selectPrev', when: { focus: ['channel-rack'] }, repeat: true },
    { chord: 'ArrowDown', command: 'channels.selectNext', when: { focus: ['channel-rack'] }, repeat: true },
  ]);
  addMenuItems('add', [cmd('channels.add', 10)]);
}
