import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useStore } from 'zustand';
import { closeContextMenu, menuStore, type MenuOpen } from './context-menu-store';
import { holdModal } from './Dialog';
import { moveInPanel } from './menu-nav';
import { placeAtPointer } from './place';
import { MenuItems, panelKeys } from './ContextMenuItems';
import { panelItems } from './menu-nav';
import styles from './ContextMenu.module.css';

export { closeContextMenu, isContextMenuOpen, showContextMenu, type MenuEntry } from './context-menu-store';

/** A press held this long (ms) lets go of the swallowed events eventually. */
const MAX_SWALLOW_MS = 4000;

/**
 * The press that closed a menu does nothing else: its pointer up, click and right-click menu never
 * reach what is under it (no new menu, no clip placed or deleted, no button pressed).
 */
function swallowRestOfPress(pointerId: number): void {
  const types = ['pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'auxclick', 'contextmenu'] as const;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => {
    clearTimeout(timer);
    for (const t of types) window.removeEventListener(t, stop, true);
  };
  function stop(e: Event) {
    const pointer = e instanceof PointerEvent && (e.type === 'pointerup' || e.type === 'pointercancel');
    if (pointer && e.pointerId !== pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    // The click (or auxclick) of this press comes right after its pointer up.
    if (pointer) {
      clearTimeout(timer);
      timer = setTimeout(done, 0);
    }
  }
  for (const t of types) window.addEventListener(t, stop, true);
  // A press held a long time still lets go of these eventually.
  timer = setTimeout(done, MAX_SWALLOW_MS);
}

/**
 * While a menu is open it has the keyboard (shortcuts and the typing piano wait), a click outside only closes it, scrolling or
 * zooming what it was opened on closes it, Esc closes it, and the first arrow key (when it was opened with the mouse) moves into it.
 */
function useOpenMenuBehaviour(
  open: MenuOpen | null,
  menuRef: RefObject<HTMLDivElement | null>,
  opener: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const release = holdModal();
    const inside = (e: Event) => !!menuRef.current?.contains(e.target as Node);
    const onDown = (e: PointerEvent) => {
      if (inside(e)) return;
      // A click outside only closes the menu (and does not pull the focus back to where the keyboard was).
      e.preventDefault();
      e.stopPropagation();
      opener.current = null;
      swallowRestOfPress(e.pointerId);
      closeContextMenu();
    };
    // Scrolling or zooming what the menu was opened on: the spot it is about moves away.
    const onWheel = (e: WheelEvent) => {
      if (!inside(e)) closeContextMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
        return;
      }
      // Tab leaves a menu: it closes (the focus goes back to where it was opened from).
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
        return;
      }
      // Opened with the mouse: the first arrow key moves into the menu.
      const menu = menuRef.current;
      if (menu && !menu.contains(document.activeElement) && moveInPanel(e, menu)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    return () => {
      release();
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeContextMenu);
      window.removeEventListener('resize', closeContextMenu);
    };
  }, [open, menuRef, opener]);
}

/**
 * Keyboard users get the menu with the focus on its first entry, and the focus goes back to the control that opened
 * it when the menu closes (by Esc or by choosing an entry). A mouse-opened menu leaves the focus alone, as it always did.
 * Returns the opener, which `useOpenMenuBehaviour` clears when a click outside closes the menu.
 */
function useMenuFocus(open: MenuOpen | null, ready: boolean, menuRef: RefObject<HTMLDivElement | null>): RefObject<HTMLElement | null> {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body && active.matches(':focus-visible') ? active : null;
    }
    if (!open && wasOpen.current) {
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus();
    }
    wasOpen.current = open !== null;
  }, [open]);
  // The menu is hidden until it is placed, and a hidden entry cannot take the focus.
  useEffect(() => {
    if (!ready || !opener.current) return;
    const menu = menuRef.current;
    if (menu && !menu.contains(document.activeElement)) panelItems(menu)[0]?.focus();
  }, [ready, menuRef]);
  return opener;
}

/** The menu's name for a screen reader: its header (a first label entry), else "Menu". */
function headerLabel(open: MenuOpen): string {
  const first = open.items[0];
  return first?.kind === 'label' ? first.label : 'Menu';
}

/** Rendered once by the app shell. */
export function ContextMenuHost() {
  const open = useStore(menuStore, (s) => s.open);
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ for: MenuOpen; left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    // Measured after render (before paint): the menu never spills off-screen or opens under the pointer.
    setPlaced({ for: open, ...placeAtPointer(open.x, open.y, box.width, box.height, window.innerWidth, window.innerHeight) });
  }, [open]);
  const pos = open && placed?.for === open ? placed : null;
  const opener = useMenuFocus(open, pos !== null, ref);
  useOpenMenuBehaviour(open, ref, opener);

  if (!open) return null;
  return (
    <div
      ref={ref}
      className={styles.menu}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      role="menu"
      aria-label={headerLabel(open)}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={panelKeys}
    >
      <MenuItems items={open.items} header />
    </div>
  );
}
