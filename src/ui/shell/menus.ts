/**
 * Menu bar contents as data. Features append items in their register() so the menus grow with them.
 */
export type MenuItem =
  | { kind: 'command'; command: string; args?: unknown; label?: string; order: number }
  | { kind: 'separator'; order: number }
  | { kind: 'dynamic'; id: string; order: number; entries(): DynamicMenuEntry[] };

/** An item computed when the menu opens (recent files and other lists). */
export interface DynamicMenuEntry {
  label: string;
  hint?: string;
  disabled?: boolean;
  run(): void;
}

export interface MenuDef {
  id: string;
  label: string;
  order: number;
}

const menus = new Map<string, MenuDef>();
const items = new Map<string, MenuItem[]>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version++;
  for (const fn of listeners) fn();
};

export function registerMenu(def: MenuDef): void {
  menus.set(def.id, def);
  emit();
}

/** Adds items to a menu. `order` sorts items; use separators to group them. */
export function addMenuItems(menuId: string, add: MenuItem[]): () => void {
  const list = items.get(menuId) ?? [];
  list.push(...add);
  list.sort((a, b) => a.order - b.order);
  items.set(menuId, list);
  emit();
  return () => {
    items.set(
      menuId,
      (items.get(menuId) ?? []).filter((i) => !add.includes(i)),
    );
    emit();
  };
}

export function getMenus(): MenuDef[] {
  return [...menus.values()].sort((a, b) => a.order - b.order);
}

export function getMenuItems(menuId: string): MenuItem[] {
  return items.get(menuId) ?? [];
}

export function subscribeMenus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function menusVersion(): number {
  return version;
}

export const cmd = (command: string, order: number, label?: string): MenuItem => ({
  kind: 'command',
  command,
  order,
  ...(label ? { label } : {}),
});
export const sep = (order: number): MenuItem => ({ kind: 'separator', order });
