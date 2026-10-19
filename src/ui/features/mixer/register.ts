import { createElement } from 'react';
import type { Services } from '@app/services';
import { MASTER } from '@core/model/types';
import { addMixerInsert, routeChannel } from '@app/actions/mixer';
import { groupPickedTracks, linkPickedTracks, pickedInserts } from '@app/actions/mix-groups';
import { saveMixSnapshot, toggleCompare } from '@app/actions/mix-snapshots';
import { addMenuItems, cmd } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { addContextMenuItems } from '../../context-menus';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { lazyWindow } from '../../workspace/lazy';
import { MasterVolume } from './MasterVolume';
import { slotRoutingItems, stripRoutingItems } from './routing';

export function register(services: Services): void {
  registerWindowType({
    type: 'mixer',
    title: () => 'Mixer',
    component: lazyWindow(() => import('./Mixer'), (m) => m.Mixer),
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

  registerWindowType({
    type: 'mix-snapshots',
    title: () => 'Mix snapshots',
    component: lazyWindow(() => import('./SnapshotsWindow'), (m) => m.SnapshotsWindow),
    defaultRect: (ws) => ({ x: Math.max(0, ws.w - 352), y: 40, w: 340, h: Math.min(520, ws.h - 80) }),
    minSize: { w: 260, h: 220 },
  });
  registerWindowToggle(services, {
    command: 'view.mixSnapshots',
    type: 'mix-snapshots',
    title: 'Mix snapshots',
    hint: 'Save, recall and compare mixer snapshots (faders, pans, mutes, sends, effect settings)',
    chords: ['Alt+Shift+S'],
    menuOrder: 41,
  });
  registerSnapshotAndGroupCommands(services);

  services.commands.register({
    id: 'mixer.routeSelectedChannel',
    title: 'Route channel to mixer insert',
    category: 'Mixer',
    hint: 'Send the selected channel to the insert selected in the mixer',
    // The edit_channel action routes any channel to any track.
    ai: false,
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
    // The add_insert action does this with a name and levels.
    ai: false,
    run: (s) => void addMixerInsert(s),
  });
  services.commands.register({
    id: 'mixer.balance',
    title: 'Balance the mix',
    category: 'Mixer',
    hint: 'Listen to the busiest part and set the faders and the master Limiter so the song is loud but not crushed (one undo step; it waits while the song plays)',
    // The level_mix action does this inside a Studio answer.
    ai: false,
    enabled: (s) => s.assistant.store.getState().phase === 'idle',
    run: (s) => {
      // Its progress and what it changed show in the Studio.
      if (!s.commands.isChecked('view.assistant')) s.commands.run('view.assistant');
      void s.assistant.balanceMix();
    },
  });
  // FL's Ctrl+L, from either window.
  services.keymap.add([
    { chord: 'Mod+L', command: 'mixer.routeSelectedChannel', when: { focus: ['mixer'] } },
    { chord: 'Mod+L', command: 'mixer.routeSelectedChannel', when: { focus: ['channel-rack'] } },
  ]);
  addMenuItems('add', [cmd('mixer.addInsert', 50)]);
  addMenuItems('playlist', [cmd('mixer.balance', 51)]);
  // Routing relative to the selected insert, appended to the strip and slot menus.
  addContextMenuItems('mixer.strip', stripRoutingItems);
  addContextMenuItems('mixer.slot', slotRoutingItems);

  addToolbarSlot({ id: 'master-volume', area: 'center', order: 20, component: () => createElement(MasterVolume) });
}

/** Saving and comparing snapshots, and grouping or linking the tracks picked in the mixer. */
function registerSnapshotAndGroupCommands(services: Services): void {
  services.commands.register({
    id: 'mixer.snapshotSave',
    title: 'Mixer snapshot',
    category: 'Mixer',
    hint: 'Save the mixer (faders, pans, mutes, sends, effect settings) as a new snapshot you can recall or compare later',
    run: (s) => void saveMixSnapshot(s),
  });
  services.commands.register({
    id: 'mixer.snapshotCompare',
    title: 'A/B compare mixer snapshots',
    category: 'Mixer',
    hint: 'Switch between snapshot A and snapshot B now, gliding the faders so it does not click while the song plays (pick A and B in the Mix snapshots window)',
    // The mixer_snapshot action's compare does this by name.
    ai: false,
    enabled: (s) => {
      const { a, b } = s.session.getState().snapshotCompare;
      const snapshots = s.doc.getState().project.mixSnapshots ?? [];
      return snapshots.some((x) => x.id === a) && snapshots.some((x) => x.id === b);
    },
    run: (s) => void toggleCompare(s),
  });
  services.commands.register({
    id: 'mixer.groupSelected',
    title: 'Mixer group from picked tracks',
    category: 'Mixer',
    hint: 'Make a group of the mixer tracks picked with Shift-click: faders, pans, mutes and solos move together',
    // The mixer_group action's create does this with track names.
    ai: false,
    enabled: (s) => pickedInserts(s).length >= 2,
    run: (s) => void groupPickedTracks(s),
  });
  services.commands.register({
    id: 'mixer.linkSelected',
    title: 'Link selected mixer tracks',
    category: 'Mixer',
    hint: 'Quick link: join the picked mixer tracks into one group (the first one’s group, or a new one)',
    // The mixer_group action's create and join do this with track names.
    ai: false,
    enabled: (s) => pickedInserts(s).length >= 2,
    run: (s) => void linkPickedTracks(s),
  });
  services.keymap.add([
    { chord: 'Mod+G', command: 'mixer.groupSelected', when: { focus: ['mixer'] } },
    { chord: 'Mod+Shift+G', command: 'mixer.linkSelected', when: { focus: ['mixer'] } },
    { chord: 'Alt+Shift+A', command: 'mixer.snapshotCompare' },
  ]);
  addMenuItems('add', [cmd('mixer.snapshotSave', 51), cmd('mixer.groupSelected', 52), cmd('mixer.linkSelected', 53)]);
  addMenuItems('view', [cmd('mixer.snapshotCompare', 42)]);
}
