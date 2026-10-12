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
    }
  | { kind: 'separator' }
  | { kind: 'swatches'; colors: readonly string[]; selected?: string; onSelect(color: string): void }
  | { kind: 'label'; label: string };

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
      {open.items.map((item, i) => {
        if (item.kind === 'separator') return <div key={i} className={styles.separator} />;
        if (item.kind === 'label')
          return (
            <div key={i} className={styles.label}>
              {item.label}
            </div>
          );
        if (item.kind === 'swatches')
          return (
            <div key={i} className={styles.swatches}>
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
        return (
          <button
            key={i}
            role="menuitem"
            className={`${styles.item} ${item.danger ? styles.danger : ''}`}
            disabled={item.disabled}
            onPointerDown={(e) => e.preventDefault()}
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
    </div>
  );
}
