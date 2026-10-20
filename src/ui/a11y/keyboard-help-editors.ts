import type { KeyboardGroup } from './keyboard-help-data';

/**
 * The keys of the three canvas editors' keyboard cursors (playlist, piano roll, pitch editor). They are handled by the
 * editors' own key code (`ui/timeline/key-cursor`), so they are listed here by hand; `test/browser/keyboard-*.test.ts`
 * send these keys. The cursor is on while the editor's grid has the keyboard focus (Tab until its frame shows); a click
 * with the mouse hides it and gives the arrow keys back to the window until the next Tab.
 */
export const EDITOR_KEYBOARD_GROUPS: readonly KeyboardGroup[] = [
  {
    where: 'Piano roll (Tab to the grid)',
    moves: [
      { keys: '← →, ↑ ↓', what: 'Move the cursor one snap step, or one key. Every move is spoken: key, bar and beat, note length, velocity.' },
      { keys: 'Mod+← →, Mod+↑ ↓, Page Up / Page Down', what: 'One bar sideways, one octave up or down (Cmd+arrows on a Mac, where Ctrl+arrows belong to the system).' },
      { keys: 'Home / End', what: 'Start or end of the pattern.' },
      { keys: 'Shift + any move', what: 'Extend the selection over the notes the cursor crosses.' },
      { keys: 'Enter', what: 'Select or deselect the note under the cursor; on an empty cell, add a note there.' },
      { keys: 'Insert or Shift+Enter', what: 'Add a note (or the chosen chord) at the cursor.' },
      { keys: 'Delete or Backspace', what: 'Delete the selected notes, or the note under the cursor.' },
      { keys: 'Alt + arrows', what: 'Move the selected notes by a step or a key (Alt+Page Up / Page Down: an octave).' },
      { keys: 'Alt+Shift+← →, Alt+Shift+↑ ↓', what: 'Make the selected notes shorter or longer by a step; change their velocity.' },
      { keys: 'Mod+A, Esc', what: 'Select every note; clear the selection.' },
      { keys: '?', what: 'Say where the cursor is and what is selected.' },
    ],
  },
  {
    where: 'Playlist (Tab to the grid)',
    moves: [
      { keys: '← →, ↑ ↓', what: 'Move the cursor one snap step, or one track (above the first track is the marker lane). Every move is spoken: track, bar and beat, the clip, its length.' },
      { keys: 'Mod+← →, Mod+↑ ↓, Page Up / Page Down', what: 'One bar sideways, four tracks up or down.' },
      { keys: 'Home / End', what: 'Start or end of the song.' },
      { keys: 'Shift + any move', what: 'Extend the selection over the clips the cursor crosses.' },
      { keys: 'Enter', what: 'Select the clip under the cursor; on an empty cell, place the current pattern; on a marker, rename it.' },
      { keys: 'Insert or Shift+Enter', what: 'Add a clip, a marker (on the marker lane) or an automation point.' },
      { keys: 'Delete or Backspace', what: 'Delete the selected clips, the marker or the automation point under the cursor.' },
      { keys: 'Alt + arrows', what: 'Move the selected clips by a step or a track.' },
      { keys: 'Alt+Shift+← →, Alt+Shift+↑ ↓', what: 'Make the selected clips shorter or longer; change an automation point’s value.' },
      { keys: 'Mod+A, Esc', what: 'Select every clip; clear the selection.' },
      { keys: '?', what: 'Say where the cursor is and what is selected.' },
    ],
  },
  {
    where: 'Pitch editor (Tab to the grid)',
    moves: [
      { keys: '← →', what: 'Previous or next note. Each is spoken: note number, pitch with cents, time, length, word.' },
      { keys: 'Ctrl+← →, Page Up / Page Down', what: 'Five notes back or on.' },
      { keys: 'Home / End', what: 'First or last note.' },
      { keys: '↑ ↓', what: 'Retune the selected notes by a semitone (Mod+↑ ↓ an octave, Alt+↑ ↓ a cent).' },
      { keys: 'Enter', what: 'Select or deselect the note under the cursor.' },
      { keys: 'Delete or Backspace', what: 'Put the selected notes back as sung.' },
      { keys: 'S / M', what: 'Split the note in two; join it with the next one.' },
      { keys: 'Mod+A, Esc, ?', what: 'Select every note; clear the selection; say where the cursor is.' },
    ],
  },
];
