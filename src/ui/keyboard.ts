import type { Services } from '@app/services';
import { chordFromEvent } from '@core/commands/keymap';
import { rovingKeyDown } from './a11y/roving';
import { isModalOpen } from './controls/Dialog';
import { TypingPiano } from './typing-piano';

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'color'].includes(target.type);
  }
  return false;
}

/** Controls that Space and Enter press when the keyboard put the focus on them (the mouse never focuses these). */
const PRESSABLE = 'button, a[href], summary, [role="button"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="radio"]';

/**
 * True when Space or Enter should press the focused control instead of running a shortcut: the focus is on a
 * button-like control and it got there by keyboard (`:focus-visible`). Mouse clicks on toolbar buttons never move
 * the focus (their pointer-down is cancelled), so a mouse user's Space still means play/stop.
 */
function isKeyboardPress(e: KeyboardEvent): boolean {
  if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const target = e.target;
  if (!(target instanceof HTMLElement) || !target.matches(PRESSABLE)) return false;
  return target.matches(':focus-visible');
}

const UNDO_COMMANDS: ReadonlySet<string> = new Set(['edit.undo', 'edit.redo']);

function isEmptyField(target: EventTarget | null): boolean {
  return (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && target.value === '';
}

/**
 * One capture-phase listener resolves every shortcut through the keymap. Handled keys are swallowed
 * so Space never also "clicks" whatever button was focused last.
 */
export function installKeyboard(services: Services): () => void {
  const swallowedKeyUps = new Set<string>();
  const piano = new TypingPiano(services);

  const onKeyDown = (e: KeyboardEvent) => {
    // A dialog handles its own keys (Enter, Escape); nothing else should react meanwhile.
    if (isModalOpen()) return;
    // Arrow keys inside a toolbar or grid move its focus before any window shortcut sees them.
    if (rovingKeyDown(e)) {
      e.stopPropagation();
      return;
    }
    if (isKeyboardPress(e)) return;
    const inInput = isTextInput(e.target);
    // The Decks window uses the letter keys for its decks, the clip launcher the number keys for its scenes and the
    // sample browser A and F for adding and starring a sound: the typing piano stays quiet there.
    const focusedId = services.view.getState().focusedId;
    const focusedType = focusedId ? services.view.getState().windows[focusedId]?.type : undefined;
    const inDecks = focusedType === 'dj-decks' || focusedType === 'launcher' || focusedType === 'samples';
    if (!inDecks && piano.keyDown(e, inInput)) {
      e.stopPropagation();
      return;
    }
    const chord = chordFromEvent(e);
    if (!chord) return;
    const view = services.view.getState();
    const focus = view.focusedId ? (view.windows[view.focusedId]?.type ?? null) : null;
    let binding = services.keymap.match(chord, { focus, inInput });
    // In an empty text box (the Studio's, a name field) there is no typing to undo: Undo and Redo
    // step through the song's history, the Studio's changes included.
    if (!binding && inInput && isEmptyField(e.target)) {
      const outside = services.keymap.match(chord, { focus, inInput: false });
      if (outside && UNDO_COMMANDS.has(outside.command)) binding = outside;
    }
    if (!binding) return;
    if (!services.commands.isEnabled(binding.command)) return;
    e.preventDefault();
    e.stopPropagation();
    swallowedKeyUps.add(e.code);
    // Holding a shortcut should not machine-gun commands like play/stop.
    if (e.repeat && !binding.repeat) return;
    services.commands.run(binding.command, binding.args);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (piano.keyUp(e)) {
      e.preventDefault();
      return;
    }
    if (swallowedKeyUps.delete(e.code)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onBlur = () => piano.releaseAll();
  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('keyup', onKeyUp, { capture: true });
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    window.removeEventListener('keyup', onKeyUp, { capture: true });
    window.removeEventListener('blur', onBlur);
  };
}
