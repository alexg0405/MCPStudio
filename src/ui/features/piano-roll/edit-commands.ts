/** The piano roll's note editing commands: select, delete, copy, cut, paste, duplicate, transpose, nudge, quantize. */
import type { Services } from '@app/services';
import { pianoRollCommands as pr } from './commands';
import { hasNotes, hasSelection } from './conditions';

/** Registers the note editing commands (their shortcuts and menu entries are in `bindings.ts`). */
export function registerEditCommands(services: Services): void {
  const { commands } = services;
  commands.register({
    id: 'pianoRoll.selectAll',
    title: 'Select all notes',
    category: 'Piano roll',
    hint: 'Select every note of the channel',
    enabled: hasNotes,
    run: pr.selectAll,
  });
  commands.register({
    id: 'pianoRoll.deselect',
    title: 'Deselect',
    category: 'Piano roll',
    hint: 'Clear the note selection',
    run: pr.deselect,
  });
  commands.register({
    id: 'pianoRoll.delete',
    title: 'Delete selected notes',
    category: 'Piano roll',
    hint: 'Delete the selected notes',
    enabled: hasSelection,
    run: pr.deleteSelection,
  });
  commands.register({
    id: 'pianoRoll.copy',
    title: 'Copy notes',
    category: 'Piano roll',
    hint: 'Copy the selected notes',
    enabled: hasSelection,
    run: pr.copy,
  });
  commands.register({
    id: 'pianoRoll.cut',
    title: 'Cut notes',
    category: 'Piano roll',
    hint: 'Cut the selected notes',
    enabled: hasSelection,
    run: pr.cut,
  });
  commands.register({
    id: 'pianoRoll.paste',
    title: 'Paste notes',
    category: 'Piano roll',
    hint: 'Paste the copied notes right after the selection (or at the playhead while playing)',
    enabled: (s) => hasNotes(s) && !!s.editor.getState().noteClipboard?.length,
    run: pr.paste,
  });
  commands.register({
    id: 'pianoRoll.duplicate',
    title: 'Duplicate notes',
    category: 'Piano roll',
    hint: 'Copy the selected notes (or all of them) right after themselves',
    enabled: hasNotes,
    run: pr.duplicate,
  });
  commands.register<number>({
    id: 'pianoRoll.transpose',
    title: 'Transpose',
    category: 'Piano roll',
    hint: 'Move the selected notes up or down in semitones',
    argsHint: 'semitones, e.g. 2 or -12 (the notes selected in the piano roll: select them first)',
    enabled: hasNotes,
    run: (s, by) => pr.transpose(s, by ?? 1),
  });
  commands.register<1 | -1>({
    id: 'pianoRoll.nudge',
    title: 'Nudge notes',
    category: 'Piano roll',
    hint: 'Move the selected notes one grid step earlier or later',
    argsHint: '1 (later) or -1 (earlier)',
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
}
