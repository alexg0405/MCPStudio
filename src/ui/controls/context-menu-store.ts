import { createStore } from 'zustand';
import type { IconName } from './Icon';

/** One entry of a context menu. */
export type MenuEntry =
  | {
      kind?: 'item';
      label: string;
      onSelect(): void;
      disabled?: boolean;
      checked?: boolean;
      shortcut?: string;
      danger?: boolean;
      /** Hint bar text on hover (say why when disabled). */
      hint?: string;
      /** A small icon before the label (in the check column). */
      icon?: IconName;
    }
  | { kind: 'separator' }
  | { kind: 'swatches'; colors: readonly string[]; selected?: string; onSelect(color: string): void }
  /** A section label; as a menu's first entry it is its header, with a × that closes the menu. */
  | { kind: 'label'; label: string }
  /** Opens a nested menu to the side (items may be computed when it opens). */
  | { kind: 'submenu'; label: string; items: MenuEntry[] | (() => MenuEntry[]); disabled?: boolean; hint?: string };

/** The menu that is showing: where it was opened (viewport px) and its entries. */
export interface MenuOpen {
  x: number;
  y: number;
  items: MenuEntry[];
}

/** Which context menu is open, outside React so any code can open or close it. */
export const menuStore = createStore<{ open: MenuOpen | null }>(() => ({ open: null }));

/** Opens a context menu at the pointer (or at an explicit position). */
export function showContextMenu(at: { clientX: number; clientY: number } | { x: number; y: number }, items: MenuEntry[]): void {
  const x = 'clientX' in at ? at.clientX : at.x;
  const y = 'clientY' in at ? at.clientY : at.y;
  menuStore.setState({ open: { x, y, items } });
}

/** Closes the context menu, if one is open. */
export function closeContextMenu(): void {
  if (menuStore.getState().open) menuStore.setState({ open: null });
}

/** A context menu is showing (editors hold their view still meanwhile). */
export function isContextMenuOpen(): boolean {
  return menuStore.getState().open !== null;
}
