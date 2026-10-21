/**
 * Roving focus: a group of controls that is one stop for Tab, with the arrow keys moving inside it.
 *
 * Mark the container in the markup and the rest is automatic:
 *
 *     <div role="toolbar" aria-label="Piano roll tools" data-roving>…buttons…</div>
 *
 * - `data-roving` (or `data-roving="horizontal"`): Left and Right move, Home and End jump to the ends. A `role="toolbar"`,
 *   `tablist` or `radiogroup` is a group even without the mark (`aria-orientation="vertical"` makes it vertical).
 *   A list box opts in with `data-roving="vertical"` (a palette's results are not one: they follow `aria-activedescendant`).
 * - `data-roving="vertical"`: Up and Down move (a list of rows).
 * - `data-roving="grid"`: all four arrows move to the nearest control in that direction (the channel rack's steps,
 *   the clip launcher's pads). Home and End go to the ends of the row, Ctrl+Home and Ctrl+End to the corners.
 *
 * The group's active control has `tabindex="0"` and every other one `tabindex="-1"`, so Tab enters the group once
 * and the next Tab leaves it. Controls that appear later (a React re-render, a window opening) are picked up by
 * one observer on the page. Controls the markup did not mark with `tabIndex` at all are fine too: this module is
 * what makes them one stop.
 *
 * This is DOM code on purpose: the groups are dense (a step grid has hundreds of controls), and React never has to
 * re-render a whole row to move a tab stop.
 */

/** Which controls a group manages: anything a person can press or pick, but not a field the arrows edit. */
const ITEM_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="checkbox"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[data-roving-item]',
].join(',');

/** How a group's arrow keys move. */
export type RovingMode = 'horizontal' | 'vertical' | 'grid';

/** How far (in pixels) two controls' centres may differ and still count as the same row (or column) of a grid. */
const SAME_LINE_TOLERANCE = 0.6;

/**
 * What makes a group: the explicit `data-roving` mark, and the roles whose arrow keys are defined by the ARIA patterns
 * (toolbar, tab strip, radio group), so a plain `role="toolbar"` is one Tab stop without anyone remembering the mark.
 */
const GROUP_SELECTOR = '[data-roving], [role="toolbar"], [role="tablist"], [role="radiogroup"]';

/** The control each group last had focus, so Tab comes back to it. */
const activeItems = new WeakMap<Element, Element>();
/** Groups whose tab stops need re-checking from scratch at the next flush. */
const dirtyGroups = new Set<Element>();
/**
 * Elements added inside a group that already has its Tab stop: at the next flush only these are looked at, because
 * scanning a dense group again (the channel rack's step grid has a thousand controls) for each row that scrolls into
 * view made scrolling cost more than the rows themselves.
 */
const addedInGroup = new Map<Element, Element[]>();
let flushScheduled = false;

function modeOf(group: Element): RovingMode {
  const value = group.getAttribute('data-roving');
  if (value === 'vertical' || value === 'grid' || value === 'horizontal') return value;
  if (group.getAttribute('aria-orientation') === 'vertical') return 'vertical';
  return 'horizontal';
}

function isUsable(el: Element): boolean {
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('hidden')) return false;
  if (el instanceof HTMLElement && el.closest('[hidden], [inert]')) return false;
  // A control that takes no room (display: none, or inside something that does) cannot hold the Tab stop.
  return el.getClientRects().length > 0;
}

/**
 * True when the control is an entry of a menu that opens from inside the group (the menu bar's dropdowns, a toolbar
 * button's menu): that menu moves its own focus with the arrows, so the group must not count its entries.
 */
function isInsideOwnMenu(el: Element, group: Element): boolean {
  const menu = el.closest('[role="menu"]');
  return menu !== null && menu !== group && group.contains(menu);
}

/** True when `el` belongs to `group` itself: not in a roving group nested inside it, and not an entry of a menu it opens. */
function isOwnControl(el: HTMLElement, group: Element): boolean {
  return el.closest(GROUP_SELECTOR) === group && !isInsideOwnMenu(el, group);
}

/** True when `el` is a control `group` manages: its own, and one that takes room (so it can hold the Tab stop). */
function isGroupItem(el: HTMLElement, group: Element): boolean {
  return isOwnControl(el, group) && isUsable(el);
}

/**
 * The control of `group` that is, or contains, `target`: the outermost one when controls are nested (the same one
 * a search through the group's controls in page order finds first), without looking at the rest of the group.
 */
function itemContaining(group: Element, target: HTMLElement): HTMLElement | null {
  let found: HTMLElement | null = null;
  for (let el: HTMLElement | null = target; el && el !== group; el = el.parentElement) {
    if (el.matches(ITEM_SELECTOR) && isGroupItem(el, group)) found = el;
  }
  return found;
}

/** The controls a group manages: its own, not those of a roving group nested inside it. */
export function rovingItems(group: Element): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const el of group.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) {
    if (isGroupItem(el, group)) items.push(el);
  }
  return items;
}

/** Makes exactly one control of the group the Tab stop: the remembered one, or the first. */
function syncGroup(group: Element): void {
  const items = rovingItems(group);
  if (items.length === 0) return;
  const remembered = activeItems.get(group);
  const active = remembered && items.includes(remembered as HTMLElement) ? remembered : items[0]!;
  activeItems.set(group, active);
  for (const item of items) setStop(item, item === active);
}

function setStop(item: Element, isActive: boolean): void {
  const wanted = isActive ? '0' : '-1';
  if (item.getAttribute('tabindex') !== wanted) item.setAttribute('tabindex', wanted);
}

/** The group's remembered Tab stop, when it is still in the page (otherwise the group needs a full look). */
function liveStop(group: Element): Element | null {
  const active = activeItems.get(group);
  return active?.isConnected ? active : null;
}

/**
 * Gives the controls inside the newly added `roots` their Tab stop state without looking at the rest of the group. A
 * control that takes no room gets its tabindex too, which does no harm, and asking would force a layout for nothing.
 */
function syncAdded(group: Element, roots: readonly Element[]): void {
  const active = liveStop(group);
  if (!active) {
    syncGroup(group);
    return;
  }
  for (const root of roots) {
    if (!root.isConnected) continue;
    if (root instanceof HTMLElement && root.matches(ITEM_SELECTOR) && isOwnControl(root, group)) setStop(root, root === active);
    for (const el of root.querySelectorAll<HTMLElement>(ITEM_SELECTOR)) {
      if (isOwnControl(el, group)) setStop(el, el === active);
    }
  }
}

function flush(): void {
  flushScheduled = false;
  const groups = [...dirtyGroups];
  dirtyGroups.clear();
  const added = new Map(addedInGroup);
  addedInGroup.clear();
  for (const group of groups) {
    added.delete(group);
    if (group.isConnected) syncGroup(group);
  }
  for (const [group, roots] of added) if (group.isConnected) syncAdded(group, roots);
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

function markDirty(group: Element): void {
  dirtyGroups.add(group);
  scheduleFlush();
}

/** Something was added inside `group`: a group with a Tab stop only checks the new controls, one without looks at all of them. */
function markAdded(group: Element, root: Element): void {
  if (!liveStop(group)) {
    markDirty(group);
    return;
  }
  const roots = addedInGroup.get(group);
  if (roots) roots.push(root);
  else addedInGroup.set(group, [root]);
  scheduleFlush();
}

/** Re-checks every group inside `root` (and the one `root` sits in). */
function markAround(root: Element): void {
  const own = root.closest(GROUP_SELECTOR);
  if (own && own !== root) markAdded(own, root);
  if (root.matches?.(GROUP_SELECTOR)) markDirty(root);
  for (const group of root.querySelectorAll(GROUP_SELECTOR)) markDirty(group);
}

/** The control the arrow key moves to from `from` in a group, or null at an edge. */
function neighbour(group: Element, items: HTMLElement[], from: HTMLElement, key: string, ctrl: boolean): HTMLElement | null {
  const mode = modeOf(group);
  const index = items.indexOf(from);
  if (key === 'Home') return mode === 'grid' && !ctrl ? firstInLine(items, from) : items[0]!;
  if (key === 'End') return mode === 'grid' && !ctrl ? lastInLine(items, from) : items[items.length - 1]!;
  if (mode === 'horizontal') {
    if (key === 'ArrowRight') return items[(index + 1) % items.length] ?? null;
    if (key === 'ArrowLeft') return items[(index - 1 + items.length) % items.length] ?? null;
    return null;
  }
  if (mode === 'vertical') {
    if (key === 'ArrowDown') return items[(index + 1) % items.length] ?? null;
    if (key === 'ArrowUp') return items[(index - 1 + items.length) % items.length] ?? null;
    return null;
  }
  return gridNeighbour(items, from, key);
}

function centre(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}

function inSameRow(a: ReturnType<typeof centre>, b: ReturnType<typeof centre>): boolean {
  return Math.abs(a.y - b.y) <= Math.max(a.h, b.h) * SAME_LINE_TOLERANCE;
}

function firstInLine(items: HTMLElement[], from: HTMLElement): HTMLElement {
  const here = centre(from);
  const row = items.filter((item) => inSameRow(here, centre(item)));
  return row.reduce((best, item) => (centre(item).x < centre(best).x ? item : best), from);
}

function lastInLine(items: HTMLElement[], from: HTMLElement): HTMLElement {
  const here = centre(from);
  const row = items.filter((item) => inSameRow(here, centre(item)));
  return row.reduce((best, item) => (centre(item).x > centre(best).x ? item : best), from);
}

/** The nearest control in the arrow's direction: the same row for Left and Right, the next row down or up for Up and Down. */
function gridNeighbour(items: HTMLElement[], from: HTMLElement, key: string): HTMLElement | null {
  const here = centre(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const item of items) {
    if (item === from) continue;
    const there = centre(item);
    const dx = there.x - here.x;
    const dy = there.y - here.y;
    const sameRow = inSameRow(here, there);
    let score: number;
    if (key === 'ArrowRight' && sameRow && dx > 1) score = dx;
    else if (key === 'ArrowLeft' && sameRow && dx < -1) score = -dx;
    else if (key === 'ArrowDown' && !sameRow && dy > 1) score = dy * 1000 + Math.abs(dx);
    else if (key === 'ArrowUp' && !sameRow && dy < -1) score = -dy * 1000 + Math.abs(dx);
    else continue;
    if (score < bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/** A field whose own keys use the arrows (a text box, a number box, a dropdown, a range slider). */
function isArrowField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit'].includes(target.type);
  return target.getAttribute('role') === 'slider' || target.getAttribute('role') === 'spinbutton';
}

/**
 * Handles an arrow key pressed on a control inside a roving group: focuses its neighbour. Returns true when it
 * moved the focus (the caller then stops the event). The global shortcut handler calls this first, so a group
 * keeps its arrows even where the window binds them to something else.
 */
export function rovingKeyDown(e: KeyboardEvent): boolean {
  if (!ARROWS.has(e.key) || e.altKey || e.metaKey || e.shiftKey) return false;
  const target = e.target;
  if (!(target instanceof HTMLElement) || isArrowField(target)) return false;
  const group = target.closest(GROUP_SELECTOR);
  if (!group) return false;
  const items = rovingItems(group);
  const from = items.find((item) => item === target || item.contains(target));
  if (!from) return false;
  const next = neighbour(group, items, from, e.key, e.ctrlKey);
  if (!next) return false;
  e.preventDefault();
  if (next !== from) focusItem(group, next);
  return true;
}

/** Moves the group's Tab stop to `item` and focuses it. */
export function focusItem(group: Element, item: HTMLElement): void {
  activeItems.set(group, item);
  syncGroup(group);
  item.focus();
  // A control that scrolls (a long toolbar, a clipped grid row) comes into view without jumping the page.
  item.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

/** Starts keeping every `data-roving` group's Tab stop in order. Returns how to stop. */
export function installRoving(): () => void {
  if (typeof document === 'undefined') return () => {};
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const group = (record.target as Element).closest(GROUP_SELECTOR);
        if (group) markDirty(group);
        continue;
      }
      for (const node of record.addedNodes) if (node instanceof Element) markAround(node);
      // Something left: its group may have lost its Tab stop (only then does it need a full look).
      const group = record.target instanceof Element ? record.target.closest(GROUP_SELECTOR) : null;
      if (group && record.removedNodes.length > 0 && !liveStop(group)) markDirty(group);
    }
  });
  const onFocusIn = (e: FocusEvent): void => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const group = target.closest(GROUP_SELECTOR);
    if (!group) return;
    const item = itemContaining(group, target);
    const previous = activeItems.get(group);
    if (!item || previous === item) return;
    activeItems.set(group, item);
    // Only the two controls whose stop changed need their tabindex written; the rest of the group is as it was.
    if (previous?.isConnected) setStop(previous, false);
    setStop(item, true);
  };
  // The global shortcut handler (src/ui/keyboard.ts) calls `rovingKeyDown` first, but it stands down while a dialog or
  // a menu is open. This listener catches those arrow keys on their way up, so a radio group in a dialog still moves.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    if (rovingKeyDown(e)) e.stopPropagation();
  };
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'hidden', 'data-roving', 'role'],
  });
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('keydown', onKeyDown);
  markAround(document.body);
  return () => {
    observer.disconnect();
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('keydown', onKeyDown);
  };
}
