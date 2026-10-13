import { createElement } from 'react';
import type { Services } from '@app/services';
import { MASTER } from '@core/model/types';
import { addMixerInsert, routeChannel } from '@app/actions/mixer';
import { addMenuItems, cmd } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { Mixer } from './Mixer';
import { MasterVolume } from './MasterVolume';

export function register(services: Services): void {
  registerWindowType({
    type: 'mixer',
    title: () => 'Mixer',
    component: Mixer,
    defaultRect: (ws) => ({
      x: 36,
      y: Math.round(ws.h * 0.4),
      w: Math.max(560, ws.w - 72),
      h: Math.max(300, Math.round(ws.h * 0.56)),
    }),
    minSize: { w: 480, h: 280 },
  });
  registerWindowToggle(services, {
    command: 'view.mixer',
    type: 'mixer',
    title: 'Mixer',
    hint: 'Show or hide the mixer',
    chords: ['F9', 'Alt+4'],
    menuOrder: 40,
  });

  services.commands.register({
    id: 'mixer.routeSelectedChannel',
    title: 'Route channel to mixer insert',
    category: 'Mixer',
    hint: 'Send the selected channel to the insert selected in the mixer',
    enabled: (s) => !!s.session.getState().selectedChannelId,
    run: (s) => {
      const { selectedChannelId, selectedInsertId } = s.session.getState();
      if (selectedChannelId) routeChannel(s, selectedChannelId, selectedInsertId ?? MASTER);
    },
  });
  services.commands.register({
    id: 'mixer.addInsert',
    title: 'Mixer insert',
    category: 'Mixer',
    hint: 'Add an insert track to the mixer',
    run: (s) => void addMixerInsert(s),
  });
  services.keymap.add([
    { chord: 'Mod+L', command: 'mixer.routeSelectedChannel', when: { focus: ['mixer', 'channel-rack'] } },
  ]);
  addMenuItems('add', [cmd('mixer.addInsert', 50)]);

  addToolbarSlot({ id: 'master-volume', area: 'center', order: 20, component: () => createElement(MasterVolume) });
}
