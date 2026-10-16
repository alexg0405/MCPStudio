import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createStore, useStore } from 'zustand';
import { holdModal } from './Dialog';
import { Icon, type IconName } from './Icon';
import { focusFirstItem, moveInPanel, submenuOf } from './menu-nav';
import { placeAtPointer, relativeToContainer } from './place';
import styles from './ContextMenu.module.css';

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

interface MenuOpen {
  x: number;
  y: number;
  items: MenuEntry[];
}

interface MenuState {
  open: MenuOpen | null;
}

const menuStore = createStore<MenuState>(() => ({ open: null }));

/** Opens a context menu at the pointer (or at an explicit position). */
export function showContextMenu(
  at: { clientX: number; clientY: number } | { x: number; y: number },
  items: MenuEntry[],
): void {
  const x = 'clientX' in at ? at.clientX : at.x;
  const y = 'clientY' in at ? at.clientY : at.y;
  menuStore.setState({ open: { x, y, items } });
}

export function closeContextMenu(): void {
  if (menuStore.getState().open) menuStore.setState({ open: null });
}

/** A context menu is showing (editors hold their view still meanwhile). */
export function isContextMenuOpen(): boolean {
  return menuStore.getState().open !== null;
}

/** How long a submenu stays open after the pointer moves on to another row (ms). */
const SUBMENU_CLOSE_DELAY = 180;

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
  timer = setTimeout(done, 4000);
}

/** Rendered once by the app shell. */
export function ContextMenuHost() {
  const open = useStore(menuStore, (s) => s.open);
  const ref = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ for: MenuOpen; left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    // Measured after render (before paint): the menu never spills off-screen or opens under the pointer.
    setPlaced({ for: open, ...placeAtPointer(open.x, open.y, r.width, r.height, window.innerWidth, window.innerHeight) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // The open menu has the keyboard: shortcuts and the typing piano wait until it closes.
    const release = holdModal();
    const inside = (e: Event) => !!ref.current?.contains(e.target as Node);
    const onDown = (e: PointerEvent) => {
      if (inside(e)) return;
      // A click outside only closes the menu.
      e.preventDefault();
      e.stopPropagation();
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
      // Opened with the mouse: the first arrow key moves into the menu.
      const menu = ref.current;
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
  }, [open]);

  if (!open) return null;
  const pos = placed?.for === open ? placed : null;
  return (
    <div
      ref={ref}
      className={styles.menu}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={panelKeys}
    >
      <MenuItems items={open.items} header />
    </div>
  );
}

/** ↑ ↓ Home End and letters move within the panel the key came from. */
function panelKeys(e: ReactKeyboardEvent<HTMLDivElement>) {
  if (moveInPanel(e, e.currentTarget)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

type SubAt = { index: number; top: number; left: number; flip: boolean };

/**
 * The entries of one menu panel; a submenu opens its own panel beside its row. In the outer panel a
 * first label is the menu's header, with a × that closes it.
 */
function MenuItems({ items, header = false }: { items: MenuEntry[]; header?: boolean }) {
  const [sub, setSub] = useState<SubAt | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const keepSub = () => clearTimeout(closeTimer.current);
  const openSub = (index: number, el: HTMLElement) => {
    keepSub();
    const r = el.getBoundingClientRect();
    const flip = r.right + 200 > window.innerWidth;
    const next: SubAt = { index, top: r.top - 5, left: flip ? r.left : r.right, flip };
    setSub((cur) => (cur?.index === next.index && cur.top === next.top && cur.left === next.left ? cur : next));
  };
  // Another row closes an open submenu after a moment: the pointer may cross one on its way to it.
  const closeSubSoon = () => {
    if (!sub) return;
    keepSub();
    closeTimer.current = setTimeout(() => setSub(null), SUBMENU_CLOSE_DELAY);
  };
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={i} className={styles.separator} />;
        if (item.kind === 'label')
          return header && i === 0 ? (
            <div key={i} className={styles.header} onPointerEnter={closeSubSoon}>
              <span className={styles.headerText}>{item.label}</span>
              <button
                type="button"
                tabIndex={-1}
                className={styles.close}
                aria-label="Close (Esc)"
                data-hint="Close (Esc)"
                onPointerDown={(e) => e.preventDefault()}
                onClick={closeContextMenu}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          ) : (
            <div key={i} className={styles.label}>
              {item.label}
            </div>
          );
        if (item.kind === 'swatches')
          return (
            <div key={i} className={styles.swatches} onPointerEnter={closeSubSoon}>
              {item.colors.map((c) => (
                <button
                  key={c}
                  className={`${styles.swatch} ${item.selected === c ? styles.swatchOn : ''}`}
                  style={{ background: c }}
                  onClick={() => {
                    closeContextMenu();
                    item.onSelect(c);
                  }}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          );
        if (item.kind === 'submenu') {
          const isOpen = sub?.index === i;
          return (
            <div
              key={i}
              className={styles.subRoot}
              onKeyDown={(e) => {
                // ← in the submenu goes back to its row.
                const row = e.currentTarget.querySelector<HTMLElement>(':scope > [role="menuitem"]');
                if (e.key !== 'ArrowLeft' || !isOpen || e.target === row) return;
                e.preventDefault();
                e.stopPropagation();
                setSub(null);
                row?.focus();
              }}
            >
              <button
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                className={`${styles.item} ${isOpen ? styles.itemOpen : ''}`}
                disabled={item.disabled}
                data-hint={item.hint}
                onPointerDown={(e) => e.preventDefault()}
                onPointerEnter={(e) => openSub(i, e.currentTarget)}
                onClick={(e) => openSub(i, e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  const row = e.currentTarget;
                  openSub(i, row);
                  focusFirstItem(() => submenuOf(row));
                }}
              >
                <span className={styles.check} />
                <span className={styles.text}>{item.label}</span>
                <Icon name="chevronRight" size={12} className={styles.arrow} />
              </button>
              {isOpen && (
                <SubPanel
                  items={typeof item.items === 'function' ? item.items() : item.items}
                  at={sub}
                  onPointerEnter={keepSub}
                />
              )}
            </div>
          );
        }
        return (
          <button
            key={i}
            role="menuitem"
            className={`${styles.item} ${item.danger ? styles.danger : ''}`}
            disabled={item.disabled}
            data-hint={item.hint}
            onPointerDown={(e) => e.preventDefault()}
            onPointerEnter={closeSubSoon}
            onClick={() => {
              closeContextMenu();
              item.onSelect();
            }}
          >
            <span className={styles.check}>{item.checked ? '✓' : item.icon ? <Icon name={item.icon} size={13} /> : ''}</span>
            <span className={styles.text}>{item.label}</span>
            {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
          </button>
        );
      })}
    </>
  );
}

function SubPanel({ items, at, onPointerEnter }: { items: MenuEntry[]; at: SubAt; onPointerEnter(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = at.flip ? Math.max(4, at.left - r.width) : Math.min(at.left, window.innerWidth - r.width - 4);
    const top = Math.max(4, Math.min(at.top, window.innerHeight - r.height - 4));
    // Fixed inside the outer panel, whose blur makes it the containing block.
    setPos(relativeToContainer({ left, top }, el.parentElement?.closest('[role="menu"]') ?? null));
  }, [at]);
  return (
    <div
      ref={ref}
      className={styles.menu}
      role="menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onKeyDown={panelKeys}
      onPointerEnter={onPointerEnter}
    >
      {items.length ? <MenuItems items={items} /> : <div className={styles.label}>Nothing here</div>}
    </div>
  );
}
