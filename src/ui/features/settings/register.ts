import type { Services } from '@app/services';
import { canChooseOutput, findOutput, listOutputs } from '@app/audio-devices';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { registerWindowType, toggleWindow } from '../../workspace/registry';
import { setWindowHelp } from '../../workspace/window-help';
import { SettingsWindow } from './SettingsWindow';

/** Settings: the sound output, MIDI, the typing keyboard, recording and help options in one window. */
export function register(services: Services): void {
  const { commands } = services;
  registerWindowType({
    type: 'settings',
    title: () => 'Settings',
    component: SettingsWindow,
    defaultRect: (ws) => ({ x: Math.max(0, ws.w / 2 - 240), y: 40, w: 480, h: Math.min(600, ws.h - 80) }),
    minSize: { w: 340, h: 220 },
  });
  commands.register({
    id: 'options.settings',
    title: 'Settings…',
    category: 'Options',
    hint: 'Sound output (speakers or headphones), MIDI keyboards, the typing piano, recording and tooltips',
    run: (s) => toggleWindow(s, 'settings'),
  });
  commands.register<string>({
    id: 'options.outputDevice',
    title: 'Sound output device',
    category: 'Options',
    hint: 'Play through other speakers or headphones',
    argsHint: "part of the device's name (e.g. 'AirPods'), or 'default'",
    palette: false,
    run: async (s, query) => {
      const toast = s.session.getState().toast;
      if (!canChooseOutput()) return toast('This browser always plays through the system output.', 'error');
      const { outputs, complete } = await listOutputs();
      const out = findOutput(outputs, String(query ?? 'default'));
      if (!out) {
        const names = outputs.slice(1).map((o) => o.label);
        return toast(
          names.length
            ? `No output is called “${String(query)}”. There are: ${names.join(', ')}.`
            : complete
              ? 'Only the system default output is connected.'
              : 'The browser lists other outputs only after Options → Settings… → “Show all my devices”.',
          'error',
        );
      }
      s.prefs.getState().set({ outputDevice: out.id });
      toast(`Playing through ${out.label}`);
    },
  });
  services.keymap.add([{ chord: 'F10', command: 'options.settings' }]);
  addMenuItems('options', [cmd('options.settings', 0), sep(0.5)]);
  setWindowHelp('settings', {
    intro: 'Settings for this browser: where the sound plays, MIDI keyboards, the typing piano, recording and help.',
    moves: [
      ['Play through', 'Choose speakers, headphones or an audio interface'],
      ['▶ Test sound', 'A chime on the left, then the right'],
      ['MIDI input', 'Play from a MIDI keyboard (Chrome asks once)'],
      ['Typing piano', 'Your letter keys play the selected sound'],
      ['Recording', 'Metronome, count-in and note snapping'],
    ],
  });
}
