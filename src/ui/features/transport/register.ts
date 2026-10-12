import { createElement } from 'react';
import type { Services } from '@app/services';
import { addMenuItems, cmd, registerMenu, sep } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { TransportBar } from './TransportBar';
import { stubTransport } from './stub-transport';

export const order = 10;

export function register(services: Services): void {
  const { commands, keymap } = services;
  registerMenu({ id: 'transport', label: 'Transport', order: 40 });

  commands.register({
    id: 'transport.playPause',
    title: 'Play / stop',
    category: 'Transport',
    hint: 'Start or stop playback',
    run: () => stubTransport.setState((s) => ({ playing: !s.playing })),
    checked: () => stubTransport.getState().playing,
  });
  commands.register({
    id: 'transport.stop',
    title: 'Stop',
    category: 'Transport',
    hint: 'Stop playback and return to the start',
    run: () => stubTransport.setState({ playing: false }),
  });
  commands.register({
    id: 'transport.record',
    title: 'Record',
    category: 'Transport',
    hint: 'Recording arrives after v1',
    enabled: () => false,
    run: () => {},
  });
  commands.register({
    id: 'transport.toggleMode',
    title: 'Pattern / song mode',
    category: 'Transport',
    hint: 'Switch between looping the current pattern (PAT) and playing the playlist (SONG)',
    run: (s) => s.view.getState().setMode(s.view.getState().mode === 'pattern' ? 'song' : 'pattern'),
    checked: (s) => s.view.getState().mode === 'song',
  });

  keymap.add([
    { chord: 'Space', command: 'transport.playPause' },
    { chord: 'L', command: 'transport.toggleMode' },
    { chord: 'R', command: 'transport.record' },
  ]);

  addMenuItems('transport', [
    cmd('transport.playPause', 10),
    cmd('transport.stop', 20),
    cmd('transport.record', 30),
    sep(40),
    cmd('transport.toggleMode', 50),
  ]);

  addToolbarSlot({ id: 'transport', area: 'transport', order: 0, component: () => createElement(TransportBar) });
}
