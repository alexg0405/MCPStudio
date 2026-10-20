/**
 * Moving between the big parts of the screen from the keyboard: the menu bar, the transport, the browser panel and every
 * open window (Ctrl+F6 goes forward, Ctrl+Shift+F6 back; Alt+9 and Alt+Shift+9 do the same where F-keys need Fn). The
 * order is the order on screen's DOM: menu, transport, browser, then the windows in the order they were opened.
 */
import type { Services } from '@app/services';
import { announce } from '../../a11y/announce';
import { firstTabStop } from '../../a11y/focusables';
import { wasKeyboardUsed } from '../../a11y/modality';

/** One part of the screen the keyboard can jump to. */
export interface Pane {
  /** What a screen reader says when focus arrives and nothing inside speaks for it. */
  label: string;
  element: HTMLElement;
  /** The window's id, for window panes (the view's focus follows). */
  windowId?: string;
}

/** The parts of the screen that exist right now, in cycling order. */
export function currentPanes(root: ParentNode = document): Pane[] {
  const panes: Pane[] = [];
  const add = (label: string, element: Element | null, windowId?: string) => {
    if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return;
    panes.push({ label, element, ...(windowId ? { windowId } : {}) });
  };
  add('Menu bar', root.querySelector('header [role="menubar"]') ?? root.querySelector('header [data-menu]')?.parentElement?.parentElement ?? null);
  add('Transport', root.querySelector('header [data-tour="transport"]'));
  add('Browser', root.querySelector('aside'));
  for (const win of root.querySelectorAll<HTMLElement>('[data-window-id]'))
    add(win.getAttribute('aria-label') ?? 'Window', win, win.dataset.windowId);
  return panes;
}

/** The index of the pane that holds the keyboard focus, or -1. */
function activePane(panes: Pane[]): number {
  const active = document.activeElement;
  return active ? panes.findIndex((pane) => pane.element.contains(active)) : -1;
}

/**
 * Puts the keyboard in `pane`: on its first control, or on the pane itself when it has none (an empty window). A window
 * pane also becomes the app's focused window, so the shortcuts of that window apply.
 */
export function focusPane(services: Services, pane: Pane): void {
  if (pane.windowId) services.view.getState().focusWindow(pane.windowId);
  const body = pane.element.querySelector('[data-window-body]') ?? pane.element;
  const target = firstTabStop(body) ?? pane.element;
  if (!target.hasAttribute('tabindex') && target === pane.element) target.setAttribute('tabindex', '-1');
  target.focus();
}

/** Moves the keyboard to the next (`direction` 1) or previous (-1) pane and says where it landed. */
export function cyclePane(services: Services, direction: 1 | -1): void {
  const panes = currentPanes();
  if (panes.length === 0) return;
  const here = activePane(panes);
  const next = here < 0 ? (direction === 1 ? 0 : panes.length - 1) : (here + direction + panes.length) % panes.length;
  const pane = panes[next]!;
  focusPane(services, pane);
  announce(pane.label);
}

/** The pane that holds the focus now, by name (for the "where am I" command), or null. */
export function activePaneLabel(): string | null {
  const panes = currentPanes();
  return panes[activePane(panes)]?.label ?? null;
}

/** Whether to move the focus by ourselves: only after a key press, never from under a mouse user. */
export function mayMoveFocus(): boolean {
  return wasKeyboardUsed();
}
