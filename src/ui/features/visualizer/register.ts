import { createElement } from 'react';
import type { Services } from '@app/services';
import { addMenuItems, cmd } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { MiniScope } from './MiniScope';
import { VisualizerWindow } from './VisualizerWindow';

/** What you hear, drawn: the toolbar scope and the Visualizer window. */
export function register(services: Services): void {
  registerWindowType({
    type: 'visualizer',
    title: () => 'Visualizer',
    component: VisualizerWindow,
    defaultRect: (ws) => ({ x: Math.max(0, ws.w - 520), y: 40, w: 500, h: 320 }),
    minSize: { w: 260, h: 180 },
  });
  registerWindowToggle(services, {
    command: 'view.visualizer',
    type: 'visualizer',
    title: 'Visualizer',
    hint: 'The spectrum and waveforms of what you hear, and their peaks',
    chords: ['Alt+V'],
    menuOrder: 55,
  });
  services.commands.register({
    id: 'view.toolbarScope',
    title: 'Toolbar scope',
    category: 'View',
    hint: 'The little waveform display in the toolbar (click it for the spectrum)',
    checked: (s) => s.prefs.getState().scopeMode !== 'off',
    run: (s) => s.prefs.getState().set({ scopeMode: s.prefs.getState().scopeMode === 'off' ? 'scope' : 'off' }),
  });
  addMenuItems('view', [cmd('view.toolbarScope', 56)]);
  addToolbarSlot({ id: 'scope', area: 'center', order: 30, component: () => createElement(MiniScope) });
  setWindowHelp('visualizer', {
    intro: 'What you hear, drawn: the master track plus previews and the metronome.',
    moves: [
      ['Top', 'The spectrum: low notes left, highs right; higher is louder'],
      ['Bottom', 'The waveforms: left in the accent color, right in green'],
      ['Peak', 'The loudest moment lately (keep it under −1 dB)'],
      ['Loudness (LUFS)…', 'Puts the Analyzer on the master for loudness and true peak'],
      ['Toolbar scope', 'Click it for the spectrum, double-click to open this window'],
    ],
  });
}
