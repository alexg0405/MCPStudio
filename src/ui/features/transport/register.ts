import { createElement } from 'react';
import type { Services } from '@app/services';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { TransportBar } from './TransportBar';
import { AudioStatus } from './AudioStatus';

export const order = 10;

export function register(services: Services): void {
  const { commands, keymap } = services;

  commands.register({
    id: 'transport.playPause',
    title: 'Play / stop',
    category: 'Transport',
    hint: 'Start or stop playback',
    run: (s) => {
      if (s.engine.playing) s.engine.stop();
      else {
        const v = s.view.getState();
        s.engine.play(v.mode === 'song' ? v.songStart : 0);
      }
    },
    checked: (s) => s.engine.playing,
  });
  commands.register({
    id: 'transport.stop',
    title: 'Stop',
    category: 'Transport',
    hint: 'Stop playback and return to the start',
    run: (s) => s.engine.stop(),
  });
  commands.register({
    id: 'transport.record',
    title: 'Record',
    category: 'Transport',
    hint: 'Arm recording: press Play to record notes and knob moves (R)',
    run: (s) => s.recording.toggle(),
    checked: (s) => s.recording.armed,
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

  // Transport lives on the toolbar; the Options menu keeps the mode switch reachable from menus.
  addMenuItems('options', [sep(1), cmd('transport.toggleMode', 2)]);

  addToolbarSlot({ id: 'transport', area: 'transport', order: 0, component: () => createElement(TransportBar) });
  addToolbarSlot({ id: 'audio-status', area: 'right', order: 0, component: () => createElement(AudioStatus) });
}
