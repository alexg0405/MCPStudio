import type { Services } from '@app/services';
import type { PianoRollTool } from '@app/stores/editor';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { addMenuItems, cmd, sep, submenu } from '../../shell/menus';
import { PianoRoll } from './PianoRoll';
import { noteTarget, pianoRollCommands as pr } from './commands';
import { quickScript, SCRIPT } from './menus';
import { openNoteScript, scriptMenuBarEntries } from './tools';

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
    ['mute', 'T', 'Mute tool'],
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

  // ---- M11 composition tools ----
  commands.register({
    id: 'pianoRoll.selectSameKey',
    title: 'Select same key',
    category: 'Piano roll',
    hint: 'Select every note on the same key as the selected notes',
    enabled: hasSelection,
    run: (s) => pr.selectSameKey(s),
  });
  commands.register({
    id: 'pianoRoll.toggleMute',
    title: 'Mute selected notes',
    category: 'Piano roll',
    hint: 'Mute the selected notes (or unmute them when they are all muted)',
    enabled: hasSelection,
    run: pr.toggleMute,
  });
  commands.register<number>({
    id: 'pianoRoll.transposeInKey',
    title: 'Transpose in key',
    category: 'Piano roll',
    hint: 'Move notes by scale steps of the song key',
    enabled: hasNotes,
    run: (s, steps) => pr.transposeInKey(s, steps ?? 1),
  });
  const hasKey = (s: Services) => !!s.doc.getState().project.transport.key;
  commands.register({
    id: 'pianoRoll.scaleSnap',
    title: 'Snap drawn notes to the scale',
    category: 'Piano roll',
    hint: 'Notes you draw, paint or move stay on the song key’s scale',
    enabled: hasKey,
    checked: (s) => s.editor.getState().pianoRoll.scaleSnap,
    run: (s) => s.editor.getState().setPianoRoll({ scaleSnap: !s.editor.getState().pianoRoll.scaleSnap }),
  });
  commands.register({
    id: 'pianoRoll.scaleHighlight',
    title: 'Highlight the scale’s rows',
    category: 'Piano roll',
    hint: 'Shades the rows of keys outside the song key’s scale and marks the root',
    enabled: hasKey,
    checked: (s) => s.editor.getState().pianoRoll.scaleHighlight,
    run: (s) => s.editor.getState().setPianoRoll({ scaleHighlight: !s.editor.getState().pianoRoll.scaleHighlight }),
  });
  commands.register<string>({
    id: 'pianoRoll.runScript',
    title: 'Run note script',
    category: 'Piano roll',
    enabled: hasNotes,
    run: (s, id) => (id ? openNoteScript(s, id).then(() => {}) : undefined),
  });
  commands.register({
    id: 'pianoRoll.legato',
    title: 'Make legato',
    category: 'Piano roll',
    hint: 'Stretch every note until the next one starts (no dialog)',
    enabled: hasNotes,
    run: (s) => void quickScript(s, SCRIPT.legato),
  });
  // Dialog tools with FL-style shortcuts (each opens the note script's dialog).
  const dialogTools: [string, string, string, string][] = [
    ['pianoRoll.quantizeTool', SCRIPT.quantize, 'Quantize…', 'Alt+Shift+Q'],
    ['pianoRoll.arpeggiate', SCRIPT.arpeggiate, 'Arpeggiate…', 'Alt+A'],
    ['pianoRoll.strum', SCRIPT.strum, 'Strum…', 'Alt+S'],
    ['pianoRoll.chop', SCRIPT.chop, 'Chop…', 'Alt+U'],
    ['pianoRoll.glue', SCRIPT.glue, 'Glue…', 'Alt+G'],
    ['pianoRoll.randomize', SCRIPT.randomize, 'Randomize…', 'Alt+R'],
  ];
  for (const [id, script, title, chord] of dialogTools) {
    commands.register({
      id,
      title,
      category: 'Piano roll',
      hint: services.plugins.script(script)?.description ?? title,
      enabled: (s) => hasNotes(s) && !!s.plugins.script(script),
      run: (s) => openNoteScript(s, script).then(() => {}),
    });
    keymap.add([{ chord, command: id, when: focus }]);
  }

  keymap.add([
    { chord: 'Mod+L', command: 'pianoRoll.legato', when: focus },
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

  // Note editing sits in the Edit menu (after undo/redo).
  addMenuItems('edit', [
    sep(100),
    cmd('pianoRoll.selectAll', 110),
    cmd('pianoRoll.cut', 120),
    cmd('pianoRoll.copy', 130),
    cmd('pianoRoll.paste', 140),
    cmd('pianoRoll.duplicate', 150),
    cmd('pianoRoll.delete', 160),
    cmd('pianoRoll.quantize', 170),
    cmd('pianoRoll.legato', 171),
    cmd('pianoRoll.selectSameKey', 172),
    cmd('pianoRoll.toggleMute', 173),
    // Every note script by category, built when the menu opens (hot-reloaded scripts included).
    submenu('pianoRoll.tools', 'Piano roll tools', 175, () => [
      { kind: 'dynamic', id: 'note-scripts', order: 0, entries: () => scriptMenuBarEntries(services) },
    ]),
  ]);
}
