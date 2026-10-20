import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { formatChord } from '@core/commands/keymap';
import { Icon } from '../controls/Icon';
import { focusFirstItem, moveInPanel, panelItems, submenuOf } from '../controls/menu-nav';
import { relativeToContainer } from '../controls/place';
import { useServices } from '../services-context';
import type { DynamicMenuEntry, MenuItem } from './menus';
import styles from './Shell.module.css';

/** The gap kept to the window's edge when a submenu is placed, in px. */
const SUBMENU_EDGE_GAP_PX = 4;
/** A submenu opens this many px above its row, so its first item lines up with the row. */
const SUBMENU_RISE_PX = 5;

/** Re-renders the menu when a command's enabled or checked state, or a key binding, may have changed. */
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

/**
 * A submenu is measured after render (before paint): beside its row, flipped left where it would spill off. The row and
 * the outer panel are measured together, so the outer panel's float-in doesn't skew it. Returns where it goes (null until measured).
 */
function useNestedPlacement(panelRef: RefObject<HTMLDivElement | null>, nested: boolean): { left: number; top: number } | null {
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const rowElement = panel?.parentElement?.querySelector(':scope > [role="menuitem"]');
    if (!nested || !panel || !rowElement) return;
    const row = rowElement.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    const fitsRight = row.right + box.width <= window.innerWidth - SUBMENU_EDGE_GAP_PX;
    const left = fitsRight ? row.right : Math.max(SUBMENU_EDGE_GAP_PX, row.left - box.width);
    const top = Math.max(SUBMENU_EDGE_GAP_PX, Math.min(row.top - SUBMENU_RISE_PX, window.innerHeight - box.height - SUBMENU_EDGE_GAP_PX));
    // Fixed inside the outer panel, whose blur makes it the containing block.
    setPlaced(relativeToContainer({ left, top }, panel.parentElement?.closest('[role="menu"]') ?? null));
  }, [panelRef, nested]);
  return placed;
}

/** The row that opens a submenu (hover, click, → or Enter); the arrow key also moves the focus into it. */
function SubmenuButton({ label, isOpen, disabled, onOpen }: { label: string; isOpen: boolean; disabled?: boolean | undefined; onOpen(): void }) {
  return (
    <button
      role="menuitem"
      tabIndex={-1}
      aria-haspopup="menu"
      aria-expanded={isOpen}
      className={`${styles.menuItem} ${isOpen ? styles.menuItemOpen : ''}`}
      disabled={disabled ?? false}
      onPointerDown={(e) => e.preventDefault()}
      onPointerEnter={onOpen}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        const row = e.currentTarget;
        onOpen();
        focusFirstItem(() => submenuOf(row));
      }}
    >
      <span className={styles.menuCheck} />
      <span className={styles.menuText}>{label}</span>
      <Icon name="chevronRight" size={12} className={styles.menuArrow} />
    </button>
  );
}

/** A submenu's row with its panel below it while it is open; ← inside the panel goes back to the row and closes it. */
function SubmenuRoot({ label, disabled, isOpen, onOpen, onCloseSub, children }: {
  label: string;
  disabled?: boolean | undefined;
  isOpen: boolean;
  onOpen(): void;
  onCloseSub(): void;
  /** The panel, made only while the submenu is open. */
  children(): ReactNode;
}) {
  const backToRow = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = e.currentTarget.querySelector<HTMLElement>(':scope > [role="menuitem"]');
    if (e.key !== 'ArrowLeft' || !isOpen || e.target === row) return;
    e.preventDefault();
    e.stopPropagation();
    onCloseSub();
    row?.focus();
  };
  return (
    <div className={styles.menuSubRoot} onKeyDown={backToRow}>
      <SubmenuButton label={label} isOpen={isOpen} disabled={disabled} onOpen={onOpen} />
      {isOpen && children()}
    </div>
  );
}

/** An entry made when the menu opened (a recent file, a marker…): a plain row. */
function DynamicEntryRow({ entry, onClose, onHover }: { entry: DynamicMenuEntry; onClose(): void; onHover(): void }) {
  return (
    <button
      role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={entry.checked === undefined ? undefined : entry.checked}
      tabIndex={-1}
      className={styles.menuItem}
      disabled={entry.disabled}
      onPointerDown={(e) => e.preventDefault()}
      onPointerEnter={onHover}
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
}

/** A row that runs a command: its check, label and key, enabled as the command says. Renders nothing for an unknown command. */
function CommandRow({ item, onClose, onHover }: { item: Extract<MenuItem, { kind: 'command' }>; onClose(): void; onHover(): void }) {
  const { commands, keymap, platform } = useServices();
  const def = commands.get(item.command);
  if (!def) return null;
  const chord = keymap.chordsFor(item.command)[0];
  const checked = commands.isChecked(item.command);
  return (
    <button
      role={def.checked ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={def.checked ? checked : undefined}
      tabIndex={-1}
      className={styles.menuItem}
      disabled={!commands.isEnabled(item.command)}
      onPointerDown={(e) => e.preventDefault()}
      onPointerEnter={onHover}
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
}

/** A nested menu of dynamic entries. */
function EntriesDropdown({ label, entries, onClose }: { label: string; entries: DynamicMenuEntry[]; onClose(): void }) {
  return <MenuDropdown label={label} items={[{ kind: 'dynamic', id: 'sub', order: 0, entries: () => entries }]} nested onClose={onClose} />;
}

interface MenuDropdownProps {
  /** The menu's name for a screen reader ("File", or the submenu row's label). */
  label: string;
  items: MenuItem[];
  /** A top-level menu: where it opens, in viewport coordinates. */
  position?: { left: number; top: number };
  /** A submenu: it opens beside its row (the button before it). */
  nested?: boolean;
  onClose(): void;
  /** Focus the first item when it opens (opened from the keyboard). */
  autoFocus?: boolean;
  /** Top-level menus only: ← and → move to the menu beside it. */
  onSideways?: (dir: -1 | 1) => void;
}

/** One panel of a menu: its rows, separators and submenus. Arrow keys move through it; a top-level panel also moves sideways. */
export function MenuDropdown({ label, items, position, nested = false, onClose, autoFocus = false, onSideways }: MenuDropdownProps) {
  useCommandsVersion();
  const [openSub, setOpenSub] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const placed = useNestedPlacement(panelRef, nested);
  useLayoutEffect(() => {
    if (autoFocus && panelRef.current) panelItems(panelRef.current)[0]?.focus();
  }, [autoFocus]);
  const closeSub = () => setOpenSub(null);

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

  const dynamicRows = (entries: DynamicMenuEntry[], prefix: string) =>
    entries.map((entry, j) => {
      const key = `${prefix}:${j}`;
      const children = entry.children;
      if (!children) return <DynamicEntryRow key={key} entry={entry} onClose={onClose} onHover={closeSub} />;
      return (
        <SubmenuRoot key={key} label={entry.label} disabled={entry.disabled} isOpen={openSub === key} onOpen={() => setOpenSub(key)} onCloseSub={closeSub}>
          {() => <EntriesDropdown label={entry.label} entries={children} onClose={onClose} />}
        </SubmenuRoot>
      );
    });

  return (
    <div
      ref={panelRef}
      className={`${styles.menuDropdown} ${nested ? styles.menuDropdownNested : ''}`}
      role="menu"
      aria-label={label}
      style={nested ? (placed ?? { left: 0, top: 0, visibility: 'hidden' }) : position}
      onKeyDown={onPanelKey}
    >
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={`sep${i}`} className={styles.menuSeparator} />;
        if (item.kind === 'dynamic') return dynamicRows(item.entries(), item.id);
        if (item.kind === 'submenu') {
          const key = `sub:${item.id}`;
          return (
            <SubmenuRoot key={key} label={item.label} isOpen={openSub === key} onOpen={() => setOpenSub(key)} onCloseSub={closeSub}>
              {() => <MenuDropdown label={item.label} items={item.items()} nested onClose={onClose} />}
            </SubmenuRoot>
          );
        }
        return <CommandRow key={item.command + i} item={item} onClose={onClose} onHover={closeSub} />;
      })}
    </div>
  );
}
