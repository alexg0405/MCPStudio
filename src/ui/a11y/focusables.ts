/** Finding what the keyboard can reach inside a part of the page. */

const TABBABLE =
  'button, a[href], input:not([type="hidden"]), select, textarea, summary, [contenteditable="true"], [tabindex]';

/** True for an element a person can see and a key can reach: displayed, not disabled, not inert. */
function canTakeFocus(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
  if (el.closest('[inert], [hidden]')) return false;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) < 0) return false;
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** Every control inside `root` that Tab stops on, in document order. */
export function tabStops(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(canTakeFocus);
}

/** The first control inside `root` that Tab stops on, or null. */
export function firstTabStop(root: ParentNode): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(TABBABLE)) if (canTakeFocus(el)) return el;
  return null;
}
