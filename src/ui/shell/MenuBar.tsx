import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { formatChord } from '@core/commands/keymap';
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
  const [openState, setOpenState] = useState<{ id: string; left: number; top: number } | null>(null);
  const open = openState?.id ?? null;
  const barRef = useRef<HTMLDivElement>(null);
  const setOpen = (id: string | null, anchor?: HTMLElement) => {
    if (!id || !anchor) return setOpenState(null);
    const r = anchor.getBoundingClientRect();
    setOpenState({ id, left: r.left, top: r.bottom + 4 });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className={styles.menuBar} ref={barRef}>
      {getMenus()
        .filter((m) => getMenuItems(m.id).length > 0)
        .map((m) => (
          <div key={m.id} className={styles.menuRoot}>
            <button
              className={`${styles.menuLabel} ${open === m.id ? styles.menuLabelOpen : ''}`}
              onPointerDown={(e) => {
                e.preventDefault();
                setOpen(open === m.id ? null : m.id, e.currentTarget);
              }}
              onPointerEnter={(e) => open && open !== m.id && setOpen(m.id, e.currentTarget)}
            >
              {m.label}
            </button>
            {openState?.id === m.id && (
              <MenuDropdown
                items={getMenuItems(m.id)}
                position={{ left: openState.left, top: openState.top }}
                onClose={() => setOpen(null)}
              />
            )}
          </div>
        ))}
    </div>
  );
}

type SubOpen = { key: string; left: number; top: number };

function MenuDropdown({
  items,
  position,
  onClose,
}: {
  items: MenuItem[];
  position: { left: number; top: number };
  onClose: () => void;
}) {
  useCommandsVersion();
  const services = useServices();
  const { commands, keymap, platform } = services;
  const [sub, setSub] = useState<SubOpen | null>(null);
  const openSub = (key: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const left = r.right + 220 > window.innerWidth ? Math.max(4, r.left - 220) : r.right;
    setSub({ key, left, top: r.top - 4 });
  };
  const closeSub = () => setSub(null);

  const subButton = (key: string, label: string, disabled = false) => (
    <button
      role="menuitem"
      aria-haspopup="menu"
      className={`${styles.menuItem} ${sub?.key === key ? styles.menuItemOpen : ''}`}
      disabled={disabled}
      onPointerDown={(e) => e.preventDefault()}
      onPointerEnter={(e) => openSub(key, e.currentTarget)}
      onClick={(e) => openSub(key, e.currentTarget)}
    >
      <span className={styles.menuCheck} />
      <span className={styles.menuText}>{label}</span>
      <span className={styles.menuChord}>▸</span>
    </button>
  );

  const dynamicEntries = (entries: DynamicMenuEntry[], prefix: string) =>
    entries.map((entry, j) => {
      const key = `${prefix}:${j}`;
      if (entry.children)
        return (
          <div key={key} className={styles.menuSubRoot}>
            {subButton(key, entry.label, entry.disabled)}
            {sub?.key === key && <EntriesDropdown entries={entry.children} position={sub} onClose={onClose} />}
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
    <div className={styles.menuDropdown} role="menu" style={position}>
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={`sep${i}`} className={styles.menuSeparator} />;
        if (item.kind === 'dynamic') return dynamicEntries(item.entries(), item.id);
        if (item.kind === 'submenu') {
          const key = `sub:${item.id}`;
          return (
            <div key={key} className={styles.menuSubRoot}>
              {subButton(key, item.label)}
              {sub?.key === key && (
                <MenuDropdown items={item.items()} position={{ left: sub.left, top: sub.top }} onClose={onClose} />
              )}
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
  position,
  onClose,
}: {
  entries: DynamicMenuEntry[];
  position: { left: number; top: number };
  onClose: () => void;
}) {
  return (
    <MenuDropdown
      items={[{ kind: 'dynamic', id: 'sub', order: 0, entries: () => entries }]}
      position={{ left: position.left, top: position.top }}
      onClose={onClose}
    />
  );
}
