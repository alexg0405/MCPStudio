/** Touch support for the whole page: the touch layout switch and the long-press and double-tap helpers. */
import type { Services } from '@app/services';
import { installTouchHelpers } from './global';
import { installTouchLayout } from './layout';

/** Installs touch support once at startup (like the keyboard). Returns how to remove it. */
export function installTouch(services: Services): () => void {
  const stopLayout = installTouchLayout(services.prefs);
  const stopHelpers = installTouchHelpers();
  return () => {
    stopLayout();
    stopHelpers();
  };
}
