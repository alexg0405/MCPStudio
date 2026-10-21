/**
 * The windows Studio can show, hide, focus and maximize. `OPEN_WINDOWS` is every registered window type
 * (plus the browser side panel) that an action may name; `WINDOWS_NOT_FOR_AI` lists the ones it may not, with
 * the reason. test/unit/ai-coverage.test.ts fails when a registered window type is in neither list.
 */
import type { ChannelId, InsertId, SlotId } from '@core/model/types';
import type { Services } from '../../services';

/** Window types an action may name, and the browser panel. */
export const OPEN_WINDOWS = [
  'mixer',
  'channel-rack',
  'piano-roll',
  'playlist',
  'plugin',
  'piano-keyboard',
  'keys',
  'history',
  'visualizer',
  'settings',
  'shortcuts',
  'keyboard-help',
  'dj',
  'dj-controllers',
  'dj-decks',
  'launcher',
  'reference',
  'meters',
  'pitch-editor',
  'vocal-cleanup',
  'vocal-align',
  'samples',
  'chords',
  'lyrics',
  'sheet-music',
  'mix-snapshots',
  'versions',
  'projects',
  'plugin-manager',
  'help',
  'features',
  'browser',
] as const;
export type OpenWindow = (typeof OPEN_WINDOWS)[number];

/** Registered window types an action may not touch, each with its reason. */
export const WINDOWS_NOT_FOR_AI: Readonly<Record<string, string>> = {
  assistant: 'Studio’s own window: opening or closing it in the middle of a conversation is the musician’s choice',
};

export const isOpenWindow = (v: unknown): v is OpenWindow => (OPEN_WINDOWS as readonly unknown[]).includes(v);

/** The id of a window instance: singletons use their type; a plugin window is per channel or effect slot. */
export function windowIdOf(type: OpenWindow, target: { channelId?: ChannelId; slotId?: SlotId }): string | null {
  if (type !== 'plugin') return type;
  if (target.slotId) return `plugin:fx:${target.slotId}`;
  if (target.channelId) return `plugin:${target.channelId}`;
  return null;
}

export type WindowAction = 'open' | 'close' | 'focus' | 'maximize' | 'restore';
export const WINDOW_ACTIONS: readonly WindowAction[] = ['open', 'close', 'focus', 'maximize', 'restore'];

/**
 * Hides, focuses, maximizes or restores a window instance that exists (open is the UI's: it needs the window
 * type's registry). The browser panel is shown or hidden. Returns what it did, or null when there was nothing to do.
 */
export function applyWindowAction(
  services: Services,
  action: Exclude<WindowAction, 'open'>,
  type: OpenWindow,
  target: { channelId?: ChannelId; insertId?: InsertId; slotId?: SlotId },
): string | null {
  const view = services.view.getState();
  if (type === 'browser') {
    if (action === 'close') view.setBrowser({ visible: false });
    else view.setBrowser({ visible: true });
    return action === 'close' ? 'Hid the browser' : 'Showed the browser';
  }
  const id = windowIdOf(type, target);
  const w = id ? view.windows[id] : undefined;
  if (!id || !w) return null;
  switch (action) {
    case 'close':
      if (!w.visible) return null;
      view.hideWindow(id);
      return `Closed the ${type} window`;
    case 'focus':
      view.focusWindow(id);
      return `Brought the ${type} window to the front`;
    case 'maximize':
      view.focusWindow(id);
      view.setMaximized(id, true);
      return `Maximized the ${type} window`;
    case 'restore':
      view.setMaximized(id, false);
      return `Restored the ${type} window`;
  }
}
