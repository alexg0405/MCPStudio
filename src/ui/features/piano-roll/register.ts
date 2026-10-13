import type { Services } from '@app/services';
import type { PianoRollTool } from '@app/stores/editor';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { addMenuItems, cmd, registerMenu, sep } from '../../shell/menus';
import { PianoRoll } from './PianoRoll';
import { noteTarget, pianoRollCommands as pr } from './commands';

export function register(services: Services): void {
  registerWindowType({
    type: 'piano-roll',
    title: (_props, s) => {
      const id = s.session.getState().selectedChannelId;
      const ch = id ? s.doc.getState().project.channels[id] : undefined;
      return ch ? `Piano roll - ${ch.name}` : 'Piano roll';
    },
    component: PianoRoll,
    defaultRect: (ws) => ({ x: 60, y: 46, w: Math.max(520, ws.w - 120), h: Math.max(320, ws.h - 92) }),
    minSize: { w: 420, h: 240 },
  });
  registerWindowToggle(services, {
    command: 'view.pianoRoll',
    type: 'piano-roll',
    title: 'Piano roll',
    hint: 'Show or hide the piano roll for the selected channel',
    chords: ['F7', 'Alt+3'],
    menuOrder: 30,
  });

  const { commands, keymap } = services;
  const focus = { focus: ['piano-roll'] as const };
  const hasNotes = (s: Services) => !!noteTarget(s);
  const hasSelection = (s: Services) => (noteTarget(s)?.selected.length ?? 0) > 0;

  const tools: [PianoRollTool, string, string][] = [
    ['draw', 'P', 'Draw tool'],
    ['paint', 'B', 'Paint tool'],
    ['delete', 'D', 'Delete tool'],
    ['slice', 'C', 'Slice tool'],
    ['select', 'E', 'Select tool'],
  ];
  for (const [tool, chord, title] of tools) {
    commands.register({
      id: `pianoRoll.tool.${tool}`,
      title,
      category: 'Piano roll',
      run: (s) => s.editor.getState().setPianoRoll({ tool }),
      checked: (s) => s.editor.getState().pianoRoll.tool === tool,
    });
    keymap.add([{ chord, command: `pianoRoll.tool.${tool}`, when: focus }]);
  }

  commands.register({
    id: 'pianoRoll.selectAll',
    title: 'Select all notes',
    category: 'Piano roll',
    enabled: hasNotes,
    run: pr.selectAll,
  });
  commands.register({ id: 'pianoRoll.deselect', title: 'Deselect', category: 'Piano roll', run: pr.deselect });
  commands.register({
    id: 'pianoRoll.delete',
    title: 'Delete selected notes',
    category: 'Piano roll',
    enabled: hasSelection,
    run: pr.deleteSelection,
  });
  commands.register({
    id: 'pianoRoll.copy',
    title: 'Copy notes',
    category: 'Piano roll',
    enabled: hasSelection,
    run: pr.copy,
  });
  commands.register({
    id: 'pianoRoll.cut',
    title: 'Cut notes',
    category: 'Piano roll',
    enabled: hasSelection,
    run: pr.cut,
  });
  commands.register({
    id: 'pianoRoll.paste',
    title: 'Paste notes',
    category: 'Piano roll',
    enabled: (s) => hasNotes(s) && !!s.editor.getState().noteClipboard?.length,
    run: pr.paste,
  });
  commands.register({
    id: 'pianoRoll.duplicate',
    title: 'Duplicate notes',
    category: 'Piano roll',
    enabled: hasNotes,
    run: pr.duplicate,
  });
  commands.register<number>({
    id: 'pianoRoll.transpose',
    title: 'Transpose',
    category: 'Piano roll',
    enabled: hasNotes,
    run: (s, by) => pr.transpose(s, by ?? 1),
  });
  commands.register<1 | -1>({
    id: 'pianoRoll.nudge',
    title: 'Nudge notes',
    category: 'Piano roll',
    enabled: hasSelection,
    run: (s, dir) => pr.nudge(s, dir ?? 1),
  });
  commands.register({
    id: 'pianoRoll.quantize',
    title: 'Quick quantize',
    category: 'Piano roll',
    hint: 'Snap note starts to the grid',
    enabled: hasNotes,
    run: pr.quantize,
  });

  keymap.add([
    { chord: 'Mod+A', command: 'pianoRoll.selectAll', when: focus },
    { chord: 'Escape', command: 'pianoRoll.deselect', when: focus },
    { chord: 'Delete', command: 'pianoRoll.delete', when: focus },
    { chord: 'Backspace', command: 'pianoRoll.delete', when: focus },
    { chord: 'Mod+C', command: 'pianoRoll.copy', when: focus },
    { chord: 'Mod+X', command: 'pianoRoll.cut', when: focus },
    { chord: 'Mod+V', command: 'pianoRoll.paste', when: focus },
    { chord: 'Mod+B', command: 'pianoRoll.duplicate', when: focus },
    { chord: 'Mod+D', command: 'pianoRoll.duplicate', when: focus },
    { chord: 'ArrowUp', command: 'pianoRoll.transpose', args: 1, when: focus, repeat: true },
    { chord: 'ArrowDown', command: 'pianoRoll.transpose', args: -1, when: focus, repeat: true },
    { chord: 'Shift+ArrowUp', command: 'pianoRoll.transpose', args: 12, when: focus, repeat: true },
    { chord: 'Shift+ArrowDown', command: 'pianoRoll.transpose', args: -12, when: focus, repeat: true },
    { chord: 'ArrowRight', command: 'pianoRoll.nudge', args: 1, when: focus, repeat: true },
    { chord: 'ArrowLeft', command: 'pianoRoll.nudge', args: -1, when: focus, repeat: true },
    { chord: 'Alt+Q', command: 'pianoRoll.quantize', when: focus },
  ]);

  registerMenu({ id: 'notes', label: 'Notes', order: 45 });
  addMenuItems('notes', [
    cmd('pianoRoll.selectAll', 10),
    cmd('pianoRoll.deselect', 20),
    sep(30),
    cmd('pianoRoll.cut', 40),
    cmd('pianoRoll.copy', 50),
    cmd('pianoRoll.paste', 60),
    cmd('pianoRoll.duplicate', 70),
    cmd('pianoRoll.delete', 80),
    sep(90),
    cmd('pianoRoll.quantize', 100),
  ]);
}
