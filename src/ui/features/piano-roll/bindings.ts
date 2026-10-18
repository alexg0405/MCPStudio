/** The piano roll's keyboard shortcuts and its entries in the Edit menu. */
import type { Services } from '@app/services';
import { addMenuItems, cmd, sep, submenu } from '../../shell/menus';
import { PIANO_ROLL_FOCUS as focus } from './conditions';
import { scriptMenuBarEntries } from './tools';

/** Shortcuts that apply while the piano roll has the focus (the tools' keys and the dialog tools' keys are with them). */
export function addPianoRollKeys(services: Services): void {
  services.keymap.add([
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
}

/** Note editing sits in the Edit menu (after undo/redo). */
export function addPianoRollEditMenu(services: Services): void {
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
