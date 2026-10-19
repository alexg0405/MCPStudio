/** The right-click menu of a channel's name in the rack. */
import { PALETTE } from '@core/model/defaults';
import type { Channel } from '@core/model/types';
import { setChannelProp, toggleSoloChannel } from '@core/ops/channels';
import { cloneChannel, deleteChannel, moveChannelBy } from '@app/actions/channels';
import type { Services } from '@app/services';
import type { MenuEntry } from '../../controls/ContextMenu';
import { extraMenuItems } from '../../context-menus';
import { openWindow } from '../../workspace/registry';

/** The entries of a channel's menu: open its piano roll, rename, colour, clone, move, solo and delete (features add more). */
export function channelMenuEntries(services: Services, channel: Channel, onRename: () => void): MenuEntry[] {
  const id = channel.id;
  return [
    {
      label: 'Piano roll',
      shortcut: 'F7',
      onSelect: () => {
        services.session.getState().selectChannel(id);
        openWindow(services, 'piano-roll');
      },
    },
    { label: 'Rename…', onSelect: onRename },
    {
      kind: 'swatches',
      colors: PALETTE,
      selected: channel.color,
      onSelect: (c) => services.history.transact('Channel color', (d) => setChannelProp(d, id, 'color', c)),
    },
    { kind: 'separator' },
    { label: 'Clone', onSelect: () => void cloneChannel(services, id) },
    { label: 'Move up', onSelect: () => moveChannelBy(services, id, -1) },
    { label: 'Move down', onSelect: () => moveChannelBy(services, id, 1) },
    { kind: 'separator' },
    {
      label: channel.solo ? 'Unsolo' : 'Solo',
      onSelect: () => services.history.transact('Solo', (d) => toggleSoloChannel(d, id)),
    },
    ...extraMenuItems('rack.channel', { channelId: id }, services),
    { kind: 'separator' },
    { label: 'Delete', danger: true, onSelect: () => deleteChannel(services, id), shortcut: 'Alt+Del' },
  ];
}
