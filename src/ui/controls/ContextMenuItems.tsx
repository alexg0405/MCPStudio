import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { closeContextMenu, type MenuEntry } from './context-menu-store';
import { Icon } from './Icon';
import { focusFirstItem, moveInPanel, submenuOf } from './menu-nav';
import { relativeToContainer } from './place';
import styles from './ContextMenu.module.css';

/** How long a submenu stays open after the pointer moves on to another row (ms). */
const SUBMENU_CLOSE_DELAY = 180;
/** A submenu opens this many px above its row, so its first item lines up with the row. */
const SUBMENU_RISE_PX = 5;
/** A submenu this wide (px) is assumed when deciding whether it fits to the right of its row. */
const SUBMENU_ASSUMED_WIDTH_PX = 200;
/** The gap kept to the window's edge when a submenu is placed, in px. */
const EDGE_GAP_PX = 4;

/** ↑ ↓ Home End and letters move within the panel the key came from. */
export function panelKeys(e: ReactKeyboardEvent<HTMLDivElement>) {
  if (moveInPanel(e, e.currentTarget)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

/** Where an open submenu goes: beside its row, flipped to the left when it would spill off the right edge. */
type SubAt = { index: number; top: number; left: number; flip: boolean };

/** A menu's first label: its title, with a × that closes the menu. */
function MenuHeader({ label, onPointerEnter }: { label: string; onPointerEnter(): void }) {
  return (
    <div className={styles.header} onPointerEnter={onPointerEnter}>
      <span className={styles.headerText}>{label}</span>
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
  );
}

/** A row of colours to pick from. */
function SwatchRow({ item, onPointerEnter }: { item: Extract<MenuEntry, { kind: 'swatches' }>; onPointerEnter(): void }) {
  return (
    <div className={styles.swatches} onPointerEnter={onPointerEnter}>
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
}

/** A row that opens a submenu beside it; ← inside the submenu goes back to the row. */
function SubmenuRow({ item, isOpen, sub, onOpen, onClose, onKeepOpen }: {
  item: Extract<MenuEntry, { kind: 'submenu' }>;
  isOpen: boolean;
  sub: SubAt | null;
  onOpen(el: HTMLElement): void;
  onClose(): void;
  onKeepOpen(): void;
}) {
  return (
    <div
      className={styles.subRoot}
      onKeyDown={(e) => {
        // ← in the submenu goes back to its row.
        const row = e.currentTarget.querySelector<HTMLElement>(':scope > [role="menuitem"]');
        if (e.key !== 'ArrowLeft' || !isOpen || e.target === row) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
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
        onPointerEnter={(e) => onOpen(e.currentTarget)}
        onClick={(e) => onOpen(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          const row = e.currentTarget;
          onOpen(row);
          focusFirstItem(() => submenuOf(row));
        }}
      >
        <span className={styles.check} />
        <span className={styles.text}>{item.label}</span>
        <Icon name="chevronRight" size={12} className={styles.arrow} />
      </button>
      {isOpen && sub && <SubPanel items={typeof item.items === 'function' ? item.items() : item.items} at={sub} onPointerEnter={onKeepOpen} />}
    </div>
  );
}

/** A plain entry: check or icon, label and shortcut. Choosing it closes the menu and runs it. */
function ItemButton({ item, onPointerEnter }: { item: Extract<MenuEntry, { kind?: 'item' }>; onPointerEnter(): void }) {
  return (
    <button
      role="menuitem"
      className={`${styles.item} ${item.danger ? styles.danger : ''}`}
      disabled={item.disabled}
      data-hint={item.hint}
      onPointerDown={(e) => e.preventDefault()}
      onPointerEnter={onPointerEnter}
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
}

/**
 * The entries of one menu panel; a submenu opens its own panel beside its row. In the outer panel a
 * first label is the menu's header, with a × that closes it.
 */
export function MenuItems({ items, header = false }: { items: MenuEntry[]; header?: boolean }) {
  const [sub, setSub] = useState<SubAt | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const keepSub = () => clearTimeout(closeTimer.current);
  const openSub = (index: number, el: HTMLElement) => {
    keepSub();
    const row = el.getBoundingClientRect();
    const flip = row.right + SUBMENU_ASSUMED_WIDTH_PX > window.innerWidth;
    const next: SubAt = { index, top: row.top - SUBMENU_RISE_PX, left: flip ? row.left : row.right, flip };
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
        if (item.kind === 'label') {
          if (header && i === 0) return <MenuHeader key={i} label={item.label} onPointerEnter={closeSubSoon} />;
          return (
            <div key={i} className={styles.label}>
              {item.label}
            </div>
          );
        }
        if (item.kind === 'swatches') return <SwatchRow key={i} item={item} onPointerEnter={closeSubSoon} />;
        if (item.kind === 'submenu') {
          return (
            <SubmenuRow key={i} item={item} isOpen={sub?.index === i} sub={sub} onOpen={(el) => openSub(i, el)} onClose={() => setSub(null)} onKeepOpen={keepSub} />
          );
        }
        return <ItemButton key={i} item={item} onPointerEnter={closeSubSoon} />;
      })}
    </>
  );
}

/** A submenu's panel: measured after render (before paint) so it sits beside its row without spilling off the window. */
function SubPanel({ items, at, onPointerEnter }: { items: MenuEntry[]; at: SubAt; onPointerEnter(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const left = at.flip ? Math.max(EDGE_GAP_PX, at.left - box.width) : Math.min(at.left, window.innerWidth - box.width - EDGE_GAP_PX);
    const top = Math.max(EDGE_GAP_PX, Math.min(at.top, window.innerHeight - box.height - EDGE_GAP_PX));
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
