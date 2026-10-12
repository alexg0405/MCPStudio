import type { Services } from '@app/services';
import { chordFromEvent } from '@core/commands/keymap';
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

/**
 * One capture-phase listener resolves every shortcut through the keymap. Handled keys are swallowed
 * so Space never also "clicks" whatever button was focused last.
 */
export function installKeyboard(services: Services): () => void {
  const swallowedKeyUps = new Set<string>();
  const piano = new TypingPiano(services);

  const onKeyDown = (e: KeyboardEvent) => {
    const inInput = isTextInput(e.target);
    if (piano.keyDown(e, inInput)) {
      e.stopPropagation();
      return;
    }
    const chord = chordFromEvent(e);
    if (!chord) return;
    const view = services.view.getState();
    const focus = view.focusedId ? (view.windows[view.focusedId]?.type ?? null) : null;
    const binding = services.keymap.match(chord, { focus, inInput });
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
