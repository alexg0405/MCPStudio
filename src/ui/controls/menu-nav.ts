/**
 * Keyboard navigation for menus (the menu bar's and context menus): a panel is a role="menu"
 * element, its items the enabled role="menuitem" buttons whose nearest panel it is (not those of a
 * submenu open inside it). Focus moves with the keys; Enter and Space click the focused button.
 */

export function panelItems(panel: Element): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
    (el) => el.closest('[role="menu"]') === panel && !(el as HTMLButtonElement).disabled,
  );
}

const labelOf = (el: Element) => (el.textContent ?? '').replace(/^[✓\s]+/, '').toLowerCase();

/**
 * ↑ ↓ (wrapping), Home, End, and a letter (the next item starting with it) inside one panel.
 * Without a focused item the keys start from the item under the pointer. True when handled.
 */
export function moveInPanel(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, panel: Element): boolean {
  const items = panelItems(panel);
  if (items.length === 0) return false;
  let i = items.indexOf(document.activeElement as HTMLElement);
  if (i < 0) i = items.findIndex((el) => el.matches(':hover'));
  let next: HTMLElement | undefined;
  switch (e.key) {
    case 'ArrowDown':
      next = items[i < 0 ? 0 : (i + 1) % items.length];
      break;
    case 'ArrowUp':
      next = items[i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length];
      break;
    case 'Home':
      next = items[0];
      break;
    case 'End':
      next = items[items.length - 1];
      break;
    default: {
      if (e.key.length !== 1 || !/\S/.test(e.key) || e.metaKey || e.ctrlKey || e.altKey) return false;
      const k = e.key.toLowerCase();
      next = [...items.slice(i + 1), ...items.slice(0, i + 1)].find((el) => labelOf(el).startsWith(k));
      if (!next) return true;
    }
  }
  next?.focus();
  return true;
}

/** Focuses the first item of a panel once it has rendered (a submenu that was just opened). */
export function focusFirstItem(find: () => Element | null | undefined): void {
  requestAnimationFrame(() => {
    const panel = find();
    if (panel) panelItems(panel)[0]?.focus();
  });
}

/** The submenu panel a row opened (rendered next to it inside the same wrapper). */
export function submenuOf(row: Element): Element | null {
  return row.parentElement?.querySelector(':scope > [role="menu"]') ?? null;
}
