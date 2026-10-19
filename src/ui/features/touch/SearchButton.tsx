import { useSyncExternalStore } from 'react';
import { CommandButton } from '../../shell/Toolbar';
import { isTouchLayout, subscribeTouchLayout } from '../../touch/layout';

/**
 * The action search as a toolbar button, shown in the touch layout only: its shortcut (Ctrl or Cmd + K) needs a keyboard,
 * and a tablet has none, so the search that finds every menu entry would otherwise have no way in.
 */
export function SearchButton() {
  const isTouch = useSyncExternalStore(subscribeTouchLayout, isTouchLayout);
  return isTouch ? <CommandButton command="help.palette" label="Search" /> : null;
}
