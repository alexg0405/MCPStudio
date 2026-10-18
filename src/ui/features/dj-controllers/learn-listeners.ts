/**
 * Page-wide listeners that let any element tagged `data-dj-target="A.play"` (the Decks window's controls) join MIDI
 * learn: in learn mode a click picks it as the control to link, a press does not also play it, and its right-click
 * menu offers "Link to controller…".
 */
import { djControllers } from '@app/dj/controllers';
import type { Services } from '@app/services';
import { isTargetId } from '@core/midi-map/targets';
import { showContextMenu } from '../../controls/ContextMenu';

/** The learn target id (`"A.play"`) of the element an event happened on, or null when it is not a deck control. */
function targetOf(e: Event): string | null {
  const element = (e.target as Element | null)?.closest?.('[data-dj-target]');
  const id = element?.getAttribute('data-dj-target') ?? null;
  return id && isTargetId(id) ? id : null;
}

/** Installs the learn-mode listeners on the document (once, at startup; there is no page to listen to in tests). */
export function installLearnModeListeners(services: Services): void {
  if (typeof document === 'undefined') return;
  const dj = djControllers(services);
  // In learn mode a click on a deck control picks it as the control to link.
  document.addEventListener(
    'click',
    (e) => {
      if (!dj.store.getState().learn) return;
      const id = targetOf(e);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      dj.learnTarget(id);
    },
    true,
  );
  // In learn mode a press on a deck control must not also play it: a fader would jump, CUE would set a cue
  // point, the platter would start a scratch. The click that follows is the one that picks the control.
  const swallowInLearn = (e: Event) => {
    if (!dj.store.getState().learn || !targetOf(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener('pointerdown', swallowInLearn, true);
  document.addEventListener('pointerup', swallowInLearn, true);
  // Right-click on a deck control: link it (unless that control has a menu of its own).
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const id = targetOf(e);
    if (!id) return;
    e.preventDefault();
    const device = dj.store.getState().selected;
    const isLinked = device ? dj.bindingsFor(device, id).length > 0 : false;
    showContextMenu(e, [
      { label: 'Link to controller…', onSelect: () => void services.commands.run('dj.controllers.learn', { target: id }) },
      ...(isLinked && device ? [{ label: 'Unlink controller', onSelect: () => dj.clearTarget(device, id) }] : []),
    ]);
  });
}
