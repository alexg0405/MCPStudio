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
    id: 'transport.metronome',
    title: 'Metronome',
    category: 'Transport',
    hint: 'Click on every beat while playing',
    run: (s) => s.prefs.getState().set({ metronome: !s.prefs.getState().metronome }),
    checked: (s) => s.prefs.getState().metronome,
  });
  commands.register<number>({
    id: 'transport.countIn',
    title: 'Count-in',
    category: 'Transport',
    hint: 'Bars of clicks before recording starts',
    run: (s, bars) => s.prefs.getState().set({ countInBars: Math.max(0, Math.min(4, Number(bars) || 0)) }),
  });
  commands.register<number>({
    id: 'transport.recordQuantize',
    title: 'Record quantize',
    category: 'Transport',
    hint: 'Snap recorded notes to a grid as you play',
    run: (s, ticks) => s.prefs.getState().set({ recordQuantize: Math.max(0, Number(ticks) || 0) }),
  });
  commands.register<string>({
    id: 'transport.recordMode',
    title: 'Record mode',
    category: 'Transport',
    hint: 'Overdub adds to existing notes; replace clears what the recording passes over',
    run: (s, mode) => s.prefs.getState().set({ recordMode: mode === 'replace' ? 'replace' : 'overdub' }),
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
    { chord: 'Alt+M', command: 'transport.metronome' },
  ]);

  // Transport lives on the toolbar; the Options menu keeps the mode switch reachable from menus.
  addMenuItems('options', [
    sep(1),
    cmd('transport.toggleMode', 2),
    sep(70),
    cmd('transport.metronome', 71),
    cmd('transport.record', 72, 'Record (arm)'),
    {
      kind: 'dynamic',
      id: 'record-settings',
      order: 73,
      entries: () => {
        const pr = services.prefs.getState();
        const choice = (label: string, checked: boolean, run: () => void) => ({ label, checked, run });
        return [
          {
            label: 'Count-in',
            run: () => {},
            children: [0, 1, 2, 4].map((bars) =>
              choice(bars ? `${bars} bar${bars > 1 ? 's' : ''}` : 'Off', pr.countInBars === bars, () =>
                services.commands.run('transport.countIn', bars),
              ),
            ),
          },
          {
            label: 'Record quantize',
            run: () => {},
            children: (
              [
                ['Off', 0],
                ['1/4', 960],
                ['1/8', 480],
                ['1/16', 240],
                ['1/32', 120],
                ['1/8 triplet', 320],
                ['1/16 triplet', 160],
              ] as const
            ).map(([label, ticks]) =>
              choice(label, pr.recordQuantize === ticks, () =>
                services.commands.run('transport.recordQuantize', ticks),
              ),
            ),
          },
          {
            label: 'Record mode',
            run: () => {},
            children: [
              choice('Overdub (add notes)', pr.recordMode === 'overdub', () =>
                services.commands.run('transport.recordMode', 'overdub'),
              ),
              choice('Replace (clear as it records)', pr.recordMode === 'replace', () =>
                services.commands.run('transport.recordMode', 'replace'),
              ),
            ],
          },
        ];
      },
    },
  ]);

  addToolbarSlot({ id: 'transport', area: 'transport', order: 0, component: () => createElement(TransportBar) });
  addToolbarSlot({ id: 'audio-status', area: 'right', order: 0, component: () => createElement(AudioStatus) });
}
