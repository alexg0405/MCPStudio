import { createElement } from 'react';
import type { Services } from '@app/services';
import { addMenuItems, cmd, registerMenu, sep } from '../../shell/menus';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { InputButtons } from './InputButtons';

export const order = 20;

export function register(services: Services): void {
  const { commands, keymap } = services;
  registerMenu({ id: 'options', label: 'Options', order: 60 });

  commands.register({
    id: 'options.typingPiano',
    title: 'Typing keyboard to piano',
    category: 'Options',
    hint: 'Play the selected channel with your computer keyboard (Z–M and Q–U rows)',
    run: (s) => s.prefs.getState().set({ typingPiano: !s.prefs.getState().typingPiano }),
    checked: (s) => s.prefs.getState().typingPiano,
  });
  const octave = (delta: number) => (s: Services) => {
    const o = Math.max(0, Math.min(9, s.prefs.getState().pianoOctave + delta));
    s.prefs.getState().set({ pianoOctave: o });
    s.session.getState().setHint(`Typing keyboard octave: C${o}`);
  };
  commands.register({
    id: 'options.octaveDown',
    title: 'Typing keyboard octave down',
    category: 'Options',
    hint: 'Move the typing keyboard (the computer keys that play notes) one octave down',
    run: octave(-1),
  });
  commands.register({
    id: 'options.octaveUp',
    title: 'Typing keyboard octave up',
    category: 'Options',
    hint: 'Move the typing keyboard (the computer keys that play notes) one octave up',
    run: octave(1),
  });
  commands.register({
    id: 'options.midiInput',
    title: 'MIDI keyboard input',
    category: 'Options',
    hint: 'Play the selected channel from a connected MIDI keyboard',
    checked: (s) => s.midi.enabled,
    run: async (s) => {
      if (s.midi.enabled) {
        s.midi.disable();
        s.prefs.getState().set({ midiInput: false });
        return;
      }
      await s.midi.enable();
      s.prefs.getState().set({ midiInput: true });
      const names = s.midi.inputNames();
      s.session
        .getState()
        .toast(names.length ? `MIDI input: ${names.join(', ')}` : 'MIDI enabled. No devices connected yet.');
    },
  });

  keymap.add([
    { chord: 'Alt+ArrowDown', command: 'options.octaveDown', repeat: true },
    { chord: 'Alt+ArrowUp', command: 'options.octaveUp', repeat: true },
  ]);
  addMenuItems('options', [
    cmd('options.typingPiano', 10),
    cmd('options.octaveDown', 20),
    cmd('options.octaveUp', 30),
    sep(40),
    cmd('options.midiInput', 50),
  ]);
  addToolbarSlot({ id: 'input', area: 'center', order: 10, component: () => createElement(InputButtons) });

  // Re-enable MIDI if it was on last time (Chrome remembers the permission).
  if (services.prefs.getState().midiInput)
    void services.midi.enable().catch(() => services.prefs.getState().set({ midiInput: false }));
}
