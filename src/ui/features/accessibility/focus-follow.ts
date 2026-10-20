/**
 * Keeps the keyboard focus where a keyboard user expects it when windows come and go. After a key press (a shortcut,
 * the action search, a menu entry) that opens a window, the focus moves into that window; when the window the focus
 * was in closes, it moves to the next window instead of falling to the page. A mouse user's focus is never moved.
 */
import type { Services } from '@app/services';
import { announce } from '../../a11y/announce';
import { currentPanes, focusPane, mayMoveFocus } from './panes';

/** How many animation frames to wait for a window's element to exist (React draws it after the store changes). */
const FRAMES_TO_WAIT = 12;

/** Calls `attempt` each animation frame until it returns true or the frames run out. */
function whenReady(attempt: () => boolean): void {
  let frames = FRAMES_TO_WAIT;
  const tick = (): void => {
    if (attempt() || --frames <= 0) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Moves the focus into window `id` once its element is on the page. */
function focusWindowWhenDrawn(services: Services, id: string): void {
  whenReady(() => {
    const pane = currentPanes().find((candidate) => candidate.windowId === id);
    if (!pane) return false;
    if (pane.element.contains(document.activeElement)) return true;
    focusPane(services, pane);
    announce(`${pane.label} window`);
    return true;
  });
}

/** Moves the focus to the front window (or the menu bar) when the focus was lost with a window that closed. */
function refocusAfterClose(services: Services): void {
  whenReady(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return true;
    const frontId = services.view.getState().focusedId;
    const panes = currentPanes();
    const pane = panes.find((candidate) => candidate.windowId === frontId) ?? panes[0];
    if (pane) focusPane(services, pane);
    return true;
  });
}

/** Starts following the view's windows; returns how to stop. */
export function installFocusFollow(services: Services): () => void {
  return services.view.subscribe((state, previous) => {
    if (!mayMoveFocus()) return;
    const opened = Object.values(state.windows).find((w) => w.visible && !previous.windows[w.id]?.visible);
    if (opened) {
      focusWindowWhenDrawn(services, opened.id);
      return;
    }
    const closed = Object.values(previous.windows).some((w) => w.visible && !state.windows[w.id]?.visible);
    if (closed) refocusAfterClose(services);
  });
}
