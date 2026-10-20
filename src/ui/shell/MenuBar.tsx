import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { holdModal } from '../controls/Dialog';
import { moveInPanel } from '../controls/menu-nav';
import { getMenuItems, getMenus, menusVersion, subscribeMenus } from './menus';
import { MenuDropdown } from './MenuDropdown';
import styles from './Shell.module.css';

function useMenusVersion() {
  return useSyncExternalStore(subscribeMenus, menusVersion);
}

/** The menu bar: File, Edit, Add… labels; one menu open at a time, opened by click or the keyboard, with ← and → moving between menus. */
export function MenuBar() {
  useMenusVersion();
  const [openState, setOpenState] = useState<{ id: string; left: number; top: number; keys: boolean } | null>(
    null,
  );
  const open = openState?.id ?? null;
  const barRef = useRef<HTMLDivElement>(null);
  /** `keys`: opened from the keyboard, so its first item takes the focus. */
  const setOpen = (id: string | null, anchor?: HTMLElement, keys = false) => {
    if (!id || !anchor) return setOpenState(null);
    const r = anchor.getBoundingClientRect();
    setOpenState({ id, left: r.left, top: r.bottom + 4, keys });
  };
  const menus = getMenus().filter((m) => getMenuItems(m.id).length > 0);
  const labelOf = (id: string) => barRef.current?.querySelector<HTMLElement>(`[data-menu="${id}"]`) ?? undefined;
  // ← and → in a menu go to the menu beside it.
  const sideways = (dir: -1 | 1) => {
    const i = menus.findIndex((m) => m.id === open);
    const next = menus[(i + dir + menus.length) % menus.length];
    const label = next ? labelOf(next.id) : undefined;
    if (next && label) setOpen(next.id, label, true);
  };

  useEffect(() => {
    if (!open) return;
    // The open menu has the keyboard: shortcuts and the typing piano wait until it closes.
    const release = holdModal();
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpenState(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      const bar = barRef.current;
      if (e.key === 'Escape') {
        e.stopPropagation();
        const hadFocus = !!bar?.contains(document.activeElement);
        setOpenState(null);
        if (hadFocus) bar?.querySelector<HTMLElement>(`[data-menu="${open}"]`)?.focus();
        return;
      }
      // Tab leaves the menu: it closes and the focus waits on its label (the next Tab moves on).
      if (e.key === 'Tab' && bar?.contains(document.activeElement)) {
        e.preventDefault();
        e.stopPropagation();
        setOpenState(null);
        bar.querySelector<HTMLElement>(`[data-menu="${open}"]`)?.focus();
        return;
      }
      // Opened with the mouse: the first arrow key moves into the menu.
      const panel = bar?.querySelector(`[data-menu="${open}"] + [role="menu"]`);
      if (panel && !bar?.contains(document.activeElement) && moveInPanel(e, panel)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      release();
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className={styles.menuBar} ref={barRef} role="menubar" aria-label="Main menu" data-roving>
      {menus.map((m) => (
        <div key={m.id} className={styles.menuRoot}>
          <button
            className={`${styles.menuLabel} ${open === m.id ? styles.menuLabelOpen : ''}`}
            data-menu={m.id}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === m.id}
            onPointerDown={(e) => {
              e.preventDefault();
              setOpen(open === m.id ? null : m.id, e.currentTarget);
            }}
            onPointerEnter={(e) => open && open !== m.id && setOpen(m.id, e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                setOpen(m.id, e.currentTarget, true);
              } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const i = menus.indexOf(m);
                const next = menus[(i + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length];
                if (next) labelOf(next.id)?.focus();
              }
            }}
          >
            {m.label}
          </button>
          {openState?.id === m.id && (
            <MenuDropdown
              label={m.label}
              items={getMenuItems(m.id)}
              position={{ left: openState.left, top: openState.top }}
              onClose={() => setOpen(null)}
              autoFocus={openState.keys}
              onSideways={sideways}
            />
          )}
        </div>
      ))}
    </div>
  );
}
