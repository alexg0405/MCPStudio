import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createStore, useStore } from 'zustand';
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
    }
  | { kind: 'separator' }
  | { kind: 'swatches'; colors: readonly string[]; selected?: string; onSelect(color: string): void }
  | { kind: 'label'; label: string }
  /** Opens a nested menu to the side (items may be computed when it opens). */
  | { kind: 'submenu'; label: string; items: MenuEntry[] | (() => MenuEntry[]); disabled?: boolean; hint?: string };

interface MenuState {
  open: { x: number; y: number; items: MenuEntry[] } | null;
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
  menuStore.setState({ open: null });
}

/** Rendered once by the app shell. */
export function ContextMenuHost() {
  const open = useStore(menuStore, (s) => s.open);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = Math.max(4, Math.min(open.x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(open.y, window.innerHeight - r.height - 4));
    // Measured after render so the menu never spills off-screen.
    setPos({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeContextMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeContextMenu();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeContextMenu);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeContextMenu);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      className={styles.menu}
      style={pos ? { left: pos.left, top: pos.top } : { left: open.x, top: open.y, visibility: 'hidden' }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItems items={open.items} />
    </div>
  );
}

/** The entries of one menu panel; a submenu opens its own panel beside its row. */
function MenuItems({ items }: { items: MenuEntry[] }) {
  const [sub, setSub] = useState<{ index: number; top: number; left: number; flip: boolean } | null>(null);
  const openSub = (index: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const flip = r.right + 200 > window.innerWidth;
    setSub({ index, top: r.top - 4, left: flip ? r.left : r.right, flip });
  };
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={i} className={styles.separator} />;
        if (item.kind === 'label')
          return (
            <div key={i} className={styles.label}>
              {item.label}
            </div>
          );
        if (item.kind === 'swatches')
          return (
            <div key={i} className={styles.swatches} onPointerEnter={() => setSub(null)}>
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
            <div key={i} className={styles.subRoot}>
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
              >
                <span className={styles.check} />
                <span className={styles.text}>{item.label}</span>
                <span className={styles.arrow}>▸</span>
              </button>
              {isOpen && <SubPanel items={typeof item.items === 'function' ? item.items() : item.items} at={sub} />}
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
            onPointerEnter={() => setSub(null)}
            onClick={() => {
              closeContextMenu();
              item.onSelect();
            }}
          >
            <span className={styles.check}>{item.checked ? '✓' : ''}</span>
            <span className={styles.text}>{item.label}</span>
            {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
          </button>
        );
      })}
    </>
  );
}

function SubPanel({ items, at }: { items: MenuEntry[]; at: { top: number; left: number; flip: boolean } }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = at.flip ? Math.max(4, at.left - r.width) : Math.min(at.left, window.innerWidth - r.width - 4);
    const top = Math.max(4, Math.min(at.top, window.innerHeight - r.height - 4));
    setPos({ left, top });
  }, [at]);
  return (
    <div
      ref={ref}
      className={styles.menu}
      role="menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: at.left, top: at.top, visibility: 'hidden' }}
    >
      {items.length ? <MenuItems items={items} /> : <div className={styles.label}>Nothing here</div>}
    </div>
  );
}
