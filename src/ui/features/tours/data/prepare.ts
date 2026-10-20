import type { Services } from '@app/services';
import { openWindow } from '../../../workspace/registry';

/** A step's `prepare` that opens the window of this type, so the card has something to point at. */
export const showWindow =
  (type: string) =>
  (services: Services): void => {
    openWindow(services, type);
  };

/** Shows the browser side panel when it is hidden. */
export function showBrowser(services: Services): void {
  if (!services.view.getState().browser.visible) services.commands.run('view.browser');
}

/** Opens the playlist and shows its chord lane (steps about the chord track need it). */
export function showChordLane(services: Services): void {
  openWindow(services, 'playlist');
  services.editor.getState().setChordLane(true);
}
