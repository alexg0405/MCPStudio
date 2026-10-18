/** The piano roll's composition commands: work in the song key, highlight chords and scale, note scripts and their dialogs. */
import type { Services } from '@app/services';
import { pianoRollCommands as pr } from './commands';
import { hasNotes, hasSelection, hasSongKey, PIANO_ROLL_FOCUS } from './conditions';
import { quickScript, SCRIPT } from './menus';
import { openNoteScript } from './tools';

/** Note script dialogs with FL-style shortcuts: command id, script, title, key. */
const DIALOG_TOOLS: ReadonlyArray<{ id: string; script: string; title: string; key: string }> = [
  { id: 'pianoRoll.quantizeTool', script: SCRIPT.quantize, title: 'Quantize…', key: 'Alt+Shift+Q' },
  { id: 'pianoRoll.arpeggiate', script: SCRIPT.arpeggiate, title: 'Arpeggiate…', key: 'Alt+A' },
  { id: 'pianoRoll.strum', script: SCRIPT.strum, title: 'Strum…', key: 'Alt+S' },
  { id: 'pianoRoll.chop', script: SCRIPT.chop, title: 'Chop…', key: 'Alt+U' },
  { id: 'pianoRoll.glue', script: SCRIPT.glue, title: 'Glue…', key: 'Alt+G' },
  { id: 'pianoRoll.randomize', script: SCRIPT.randomize, title: 'Randomize…', key: 'Alt+R' },
];

/** Registers the composition commands (their shortcuts and menu entries are in `bindings.ts`, the dialog tools' own here). */
export function registerCompositionCommands(services: Services): void {
  const { commands, keymap } = services;
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
    argsHint: 'scale steps, e.g. 1 or -2',
    enabled: hasNotes,
    run: (s, steps) => pr.transposeInKey(s, steps ?? 1),
  });
  registerViewToggles(services);
  commands.register<string>({
    id: 'pianoRoll.runScript',
    title: 'Run note script',
    category: 'Piano roll',
    hint: 'Run a note script on the selected notes (or all of them)',
    // Opens a dialog; the note_tool action runs any tool with its settings.
    ai: false,
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
  for (const { id, script, title, key } of DIALOG_TOOLS) {
    commands.register({
      id,
      title,
      category: 'Piano roll',
      hint: services.plugins.script(script)?.description ?? title,
      // These open a dialog; the note_tool action runs the same tool with its settings.
      ai: false,
      enabled: (s) => hasNotes(s) && !!s.plugins.script(script),
      run: (s) => openNoteScript(s, script).then(() => {}),
    });
    keymap.add([{ chord: key, command: id, when: PIANO_ROLL_FOCUS }]);
  }
}

/** Scale lock, and highlighting the scale's rows and the chord track's tones. */
function registerViewToggles(services: Services): void {
  const { commands } = services;
  commands.register({
    id: 'pianoRoll.scaleSnap',
    title: 'Scale lock',
    category: 'Piano roll',
    hint: 'Notes you draw, paint or drag snap to the song key’s scale, so a melody cannot leave the key',
    enabled: hasSongKey,
    checked: (s) => s.editor.getState().pianoRoll.scaleSnap,
    run: (s) => s.editor.getState().setPianoRoll({ scaleSnap: !s.editor.getState().pianoRoll.scaleSnap }),
  });
  commands.register({
    id: 'pianoRoll.chordHighlight',
    title: 'Highlight the chord tones',
    category: 'Piano roll',
    hint: 'Tints the rows of the chord track’s notes behind the notes and names each chord at the top',
    checked: (s) => s.editor.getState().pianoRoll.chordHighlight,
    run: (s) => s.editor.getState().setPianoRoll({ chordHighlight: !s.editor.getState().pianoRoll.chordHighlight }),
  });
  commands.register({
    id: 'pianoRoll.scaleHighlight',
    title: 'Highlight the scale’s rows',
    category: 'Piano roll',
    hint: 'Shades the rows of keys outside the song key’s scale and marks the root',
    enabled: hasSongKey,
    checked: (s) => s.editor.getState().pianoRoll.scaleHighlight,
    run: (s) => s.editor.getState().setPianoRoll({ scaleHighlight: !s.editor.getState().pianoRoll.scaleHighlight }),
  });
}
