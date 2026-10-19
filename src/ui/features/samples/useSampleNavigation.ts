import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import type { Services } from '@app/services';
import type { BrowserRow, SampleBrowser } from '@app/samples/browser';
import { previewRow, stopPreviewRow } from '@app/samples/actions';
import { idsBetween, toggleIn } from './filters';
import { addRowToProject } from './row-actions';
import { ROW_H } from './view';

/** What the sample list needs to move through its rows. */
interface SampleNavigationInput {
  services: Services;
  browser: SampleBrowser;
  /** The rows the list shows, in order. */
  visible: readonly BrowserRow[];
  listRef: RefObject<HTMLDivElement | null>;
  /** Play each sound as the arrow keys land on it. */
  autoPreview: boolean;
  cursorRow: BrowserRow | undefined;
  selectedRows: readonly BrowserRow[];
}

/** Which modifier keys were held for a click. */
interface ClickModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** Click selection, arrow-key stepping and the list's keyboard shortcuts. */
export function useSampleNavigation(input: SampleNavigationInput) {
  const { services, browser, visible, listRef, autoPreview, cursorRow, selectedRows } = input;

  /** Scrolls the list just far enough to bring row `index` into view. */
  const scrollToRow = (index: number) => {
    const list = listRef.current;
    if (!list) return;
    const rowTop = index * ROW_H;
    if (rowTop < list.scrollTop) list.scrollTop = rowTop;
    else if (rowTop + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = rowTop + ROW_H - list.clientHeight;
  };

  /** A click on a row: shift extends from the cursor, Cmd or Ctrl toggles, a plain click selects it and plays it. */
  const choose = (row: BrowserRow, modifiers: ClickModifiers) => {
    // The selection as it is now (a render may not have happened since the last click).
    const { selected: currentSelection, cursor: cursorId } = browser.store.getState();
    const index = visible.indexOf(row);
    if (modifiers.shiftKey && cursorId) {
      const cursorIndex = visible.findIndex((r) => r.id === cursorId);
      if (cursorIndex >= 0) {
        browser.setSelection(idsBetween(visible, cursorIndex, index), cursorId);
        return;
      }
    }
    if (modifiers.metaKey || modifiers.ctrlKey) {
      browser.setSelection(toggleIn(currentSelection, row.id), row.id);
      return;
    }
    browser.setSelection([row.id], row.id);
    void previewRow(services, row, { toggle: true });
  };

  /** Moves the cursor by `delta` rows (clamped), extending the selection when `extend` is true, and plays it when auto-preview is on. */
  const move = (delta: number, extend: boolean) => {
    if (visible.length === 0) return;
    const cursorId = browser.store.getState().cursor;
    const fromIndex = cursorId ? visible.findIndex((r) => r.id === cursorId) : -1;
    const lastIndex = visible.length - 1;
    const hasCursor = fromIndex >= 0;
    // With no cursor yet, a step down lands on the first row and a step up on the last.
    const startWithoutCursor = delta > 0 ? 0 : lastIndex;
    const unclampedIndex = hasCursor ? fromIndex + delta : startWithoutCursor;
    const toIndex = Math.min(lastIndex, Math.max(0, unclampedIndex));
    const row = visible[toIndex] as BrowserRow;
    scrollToRow(toIndex);
    if (extend && hasCursor) {
      browser.setSelection(idsBetween(visible, fromIndex, toIndex), row.id);
      return;
    }
    browser.setSelection([row.id], row.id);
    if (autoPreview) void previewRow(services, row);
  };

  const addToProject = (row: BrowserRow) => addRowToProject(services, row);

  /** Arrow keys step, Home and End jump, Enter plays or stops, A adds to the project, F stars, Esc stops the preview. */
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const hasCommandModifier = e.metaKey || e.ctrlKey || e.altKey;
    const claim = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    switch (e.key) {
      case 'ArrowDown':
        claim();
        move(1, e.shiftKey);
        break;
      case 'ArrowUp':
        claim();
        move(-1, e.shiftKey);
        break;
      case 'Home':
        claim();
        move(-visible.length, false);
        break;
      case 'End':
        claim();
        move(visible.length, false);
        break;
      case 'Enter':
        if (cursorRow) {
          claim();
          void previewRow(services, cursorRow, { toggle: true });
        }
        break;
      case 'a':
      case 'A':
        if (cursorRow && !hasCommandModifier) {
          claim();
          addToProject(cursorRow);
        }
        break;
      case 'f':
      case 'F':
        if (cursorRow && !hasCommandModifier) {
          claim();
          const starTargets = selectedRows.length > 0 ? selectedRows : [cursorRow];
          for (const r of starTargets) browser.toggleFavorite(r.id, !cursorRow.favorite);
        }
        break;
      case 'Escape':
        claim();
        stopPreviewRow(services);
        break;
    }
  };

  return { choose, move, addToProject, onKeyDown };
}
