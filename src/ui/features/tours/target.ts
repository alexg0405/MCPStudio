import type { TourTarget } from './tour-types';

const KINDS: Record<string, (name: string) => string> = {
  tour: (name) => `[data-tour="${name}"]`,
  window: (type) => `[data-window-type="${type}"]`,
  menu: (id) => `[data-menu="${id}"]`,
  slot: (id) => `[data-slot="${id}"]`,
};

/** The CSS selector for a tour target, or null when the string is not of the form `kind:name`. */
export function selectorFor(target: TourTarget): string | null {
  const colon = target.indexOf(':');
  const kind = KINDS[target.slice(0, colon)];
  const name = target.slice(colon + 1);
  if (!kind || colon < 0 || !/^[\w-]+$/.test(name)) return null;
  return kind(name);
}

/** The element a target points at right now, or null while it is not in the page. */
export function findTarget(target: TourTarget, root: ParentNode = document): HTMLElement | null {
  const selector = selectorFor(target);
  return selector ? root.querySelector<HTMLElement>(selector) : null;
}

/** An element's box when it has one on screen (a hidden or collapsed element has none). */
export function boxOf(el: Element | null): DOMRect | null {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/** Whether any part of the box lies inside the viewport. */
export function isInView(box: DOMRect, viewWidth: number, viewHeight: number): boolean {
  return box.right > 0 && box.bottom > 0 && box.left < viewWidth && box.top < viewHeight;
}
