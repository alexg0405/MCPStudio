import type { Services } from '@app/services';
import { openWindow } from './registry';

/** FL's default arrangement: the playlist fills the workspace with the channel rack floating on top. */
export function applyDefaultLayout(services: Services): void {
  openWindow(services, 'playlist');
  openWindow(services, 'channel-rack');
}
