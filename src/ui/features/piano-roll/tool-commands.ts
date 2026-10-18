/** The piano roll's tools (draw, paint, delete, mute, slice, select) as commands with their one-key shortcuts. */
import type { Services } from '@app/services';
import type { PianoRollTool } from '@app/stores/editor';
import { PIANO_ROLL_FOCUS } from './conditions';

/** Each tool with its shortcut key, title and hint. */
const TOOLS: ReadonlyArray<{ tool: PianoRollTool; key: string; title: string; hint: string }> = [
  { tool: 'draw', key: 'P', title: 'Draw tool', hint: 'Click to add a note, drag a note to move it' },
  { tool: 'paint', key: 'B', title: 'Paint tool', hint: 'Drag across the grid to paint a row of notes' },
  { tool: 'delete', key: 'D', title: 'Delete tool', hint: 'Click or drag over notes to delete them' },
  { tool: 'mute', key: 'T', title: 'Mute tool', hint: 'Click or drag over notes to mute or unmute them' },
  { tool: 'slice', key: 'C', title: 'Slice tool', hint: 'Click a note to cut it in two' },
  { tool: 'select', key: 'E', title: 'Select tool', hint: 'Drag a box around notes to select them' },
];

/** Registers `pianoRoll.tool.<name>` for each tool, and the key that picks it while the piano roll has the focus. */
export function registerToolCommands(services: Services): void {
  const { commands, keymap } = services;
  for (const { tool, key, title, hint } of TOOLS) {
    commands.register({
      id: `pianoRoll.tool.${tool}`,
      title,
      category: 'Piano roll',
      hint,
      run: (s) => s.editor.getState().setPianoRoll({ tool }),
      checked: (s) => s.editor.getState().pianoRoll.tool === tool,
    });
    keymap.add([{ chord: key, command: `pianoRoll.tool.${tool}`, when: PIANO_ROLL_FOCUS }]);
  }
}
