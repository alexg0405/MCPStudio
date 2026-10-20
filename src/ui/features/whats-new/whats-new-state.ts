import { createStore } from 'zustand';
import type { Services } from '@app/services';
import { WHATS_NEW_VERSION } from './entries';

/** Whether the What's new panel is open (outside React, so the command and the overlay share it). */
export const whatsNewStore = createStore<{ open: boolean }>(() => ({ open: false }));

/**
 * Whether the panel should open by itself: for someone who used AGstudio before (they have seen the welcome screen) and
 * has not yet seen this version's list. A first-time user has the welcome screen instead and is counted as up to date.
 */
export function isWhatsNewDue(input: {
  seenVersion: string;
  currentVersion: string;
  hasSeenWelcome: boolean;
}): boolean {
  return input.hasSeenWelcome && input.seenVersion !== input.currentVersion;
}

/** Opens the panel and remembers that this version's list was shown, so it never opens by itself twice. */
export function openWhatsNew(services: Services): void {
  services.prefs.getState().set({ whatsNewSeen: WHATS_NEW_VERSION });
  whatsNewStore.setState({ open: true });
}

export function closeWhatsNew(): void {
  whatsNewStore.setState({ open: false });
}

/**
 * At startup, after the welcome decision: opens the panel once after an update, and marks a first-time user as up to date.
 * Returns whether it opened.
 */
export function showWhatsNewAfterUpdate(services: Services): boolean {
  const { welcomeSeen, whatsNewSeen } = services.prefs.getState();
  if (!isWhatsNewDue({ seenVersion: whatsNewSeen, currentVersion: WHATS_NEW_VERSION, hasSeenWelcome: welcomeSeen })) {
    if (!welcomeSeen) services.prefs.getState().set({ whatsNewSeen: WHATS_NEW_VERSION });
    return false;
  }
  openWhatsNew(services);
  return true;
}
