import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { formatChord } from '@core/commands/keymap';
import { holdModal } from '../controls/Dialog';
import { Icon } from '../controls/Icon';
import { focusFirstItem, moveInPanel, panelItems, submenuOf } from '../controls/menu-nav';
import { relativeToContainer } from '../controls/place';
import { useServices } from '../services-context';
import { getMenuItems, getMenus, menusVersion, subscribeMenus, type DynamicMenuEntry, type MenuItem } from './menus';
import styles from './Shell.module.css';

function useMenusVersion() {
  return useSyncExternalStore(subscribeMenus, menusVersion);
}

function useCommandsVersion() {
  const { commands, keymap } = useServices();
  const [, force] = useState(0);
  useEffect(() => {
    const a = commands.subscribe(() => force((n) => n + 1));
    const b = keymap.subscribe(() => force((n) => n + 1));
    return () => {
      a();
      b();
    };
  }, [commands, keymap]);
}

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
    <div className={styles.menuBar} ref={barRef}>
      {menus.map((m) => (
        <div key={m.id} className={styles.menuRoot}>
          <button
            className={`${styles.menuLabel} ${open === m.id ? styles.menuLabelOpen : ''}`}
            data-menu={m.id}
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

function MenuDropdown({
  items,
  position,
  nested = false,
  onClose,
  autoFocus = false,
  onSideways,
}: {
  items: MenuItem[];
  /** A top-level menu: where it opens, in viewport coordinates. */
  position?: { left: number; top: number };
  /** A submenu: it opens beside its row (the button before it). */
  nested?: boolean;
  onClose: () => void;
  /** Focus the first item when it opens (opened from the keyboard). */
  autoFocus?: boolean;
  /** Top-level menus only: ← and → move to the menu beside it. */
  onSideways?: (dir: -1 | 1) => void;
}) {
  useCommandsVersion();
  const services = useServices();
  const { commands, keymap, platform } = services;
  const [sub, setSub] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (autoFocus && panelRef.current) panelItems(panelRef.current)[0]?.focus();
  }, [autoFocus]);
  // A submenu is measured after render (before paint): beside its row, flipped left where it would spill
  // off. The row and the outer panel are measured together, so the outer panel's float-in doesn't skew it.
  useLayoutEffect(() => {
    const el = panelRef.current;
    const rowEl = el?.parentElement?.querySelector(':scope > [role="menuitem"]');
    if (!nested || !el || !rowEl) return;
    const row = rowEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const left = row.right + r.width <= window.innerWidth - 4 ? row.right : Math.max(4, row.left - r.width);
    const top = Math.max(4, Math.min(row.top - 5, window.innerHeight - r.height - 4));
    // Fixed inside the outer panel, whose blur makes it the containing block.
    setPlaced(relativeToContainer({ left, top }, el.parentElement?.closest('[role="menu"]') ?? null));
  }, [nested]);
  const closeSub = () => setSub(null);

  // ← in a submenu goes back to its row (and closes it).
  const backToRow = (e: KeyboardEvent<HTMLDivElement>, isOpen: boolean) => {
    const row = e.currentTarget.querySelector<HTMLElement>(':scope > [role="menuitem"]');
    if (e.key !== 'ArrowLeft' || !isOpen || e.target === row) return;
    e.preventDefault();
    e.stopPropagation();
    closeSub();
    row?.focus();
  };
  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (moveInPanel(e, e.currentTarget)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (onSideways && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      onSideways(e.key === 'ArrowLeft' ? -1 : 1);
    }
  };

  const subButton = (key: string, label: string, disabled = false) => (
    <button
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={sub === key}
      className={`${styles.menuItem} ${sub === key ? styles.menuItemOpen : ''}`}
      disabled={disabled}
      onPointerDown={(e) => e.preventDefault()}
      onPointerEnter={() => setSub(key)}
      onClick={() => setSub(key)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        const row = e.currentTarget;
        setSub(key);
        focusFirstItem(() => submenuOf(row));
      }}
    >
      <span className={styles.menuCheck} />
      <span className={styles.menuText}>{label}</span>
      <Icon name="chevronRight" size={12} className={styles.menuArrow} />
    </button>
  );

  const dynamicEntries = (entries: DynamicMenuEntry[], prefix: string) =>
    entries.map((entry, j) => {
      const key = `${prefix}:${j}`;
      if (entry.children)
        return (
          <div key={key} className={styles.menuSubRoot} onKeyDown={(e) => backToRow(e, sub === key)}>
            {subButton(key, entry.label, entry.disabled)}
            {sub === key && <EntriesDropdown entries={entry.children} onClose={onClose} />}
          </div>
        );
      return (
        <button
          key={key}
          role="menuitem"
          className={styles.menuItem}
          disabled={entry.disabled}
          onPointerDown={(e) => e.preventDefault()}
          onPointerEnter={closeSub}
          onClick={() => {
            onClose();
            entry.run();
          }}
          data-hint={entry.hint ?? entry.label}
        >
          <span className={styles.menuCheck}>{entry.checked ? '✓' : ''}</span>
          <span className={styles.menuText}>{entry.label}</span>
          <span className={styles.menuChord} />
        </button>
      );
    });

  return (
    <div
      ref={panelRef}
      className={`${styles.menuDropdown} ${nested ? styles.menuDropdownNested : ''}`}
      role="menu"
      style={nested ? (placed ?? { left: 0, top: 0, visibility: 'hidden' }) : position}
      onKeyDown={onPanelKey}
    >
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={`sep${i}`} className={styles.menuSeparator} />;
        if (item.kind === 'dynamic') return dynamicEntries(item.entries(), item.id);
        if (item.kind === 'submenu') {
          const key = `sub:${item.id}`;
          return (
            <div key={key} className={styles.menuSubRoot} onKeyDown={(e) => backToRow(e, sub === key)}>
              {subButton(key, item.label)}
              {sub === key && <MenuDropdown items={item.items()} nested onClose={onClose} />}
            </div>
          );
        }
        const def = commands.get(item.command);
        if (!def) return null;
        const enabled = commands.isEnabled(item.command);
        const checked = commands.isChecked(item.command);
        const chord = keymap.chordsFor(item.command)[0];
        return (
          <button
            key={item.command + i}
            role="menuitem"
            className={styles.menuItem}
            disabled={!enabled}
            onPointerDown={(e) => e.preventDefault()}
            onPointerEnter={closeSub}
            onClick={() => {
              onClose();
              commands.run(item.command, item.args);
            }}
            data-hint={def.hint ?? def.title}
          >
            <span className={styles.menuCheck}>{checked ? '✓' : ''}</span>
            <span className={styles.menuText}>{item.label ?? def.title}</span>
            <span className={styles.menuChord}>{chord ? formatChord(chord, platform) : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A nested menu of dynamic entries. */
function EntriesDropdown({
  entries,
  onClose,
}: {
  entries: DynamicMenuEntry[];
  onClose: () => void;
}) {
  return (
    <MenuDropdown
      items={[{ kind: 'dynamic', id: 'sub', order: 0, entries: () => entries }]}
      nested
      onClose={onClose}
    />
  );
}
