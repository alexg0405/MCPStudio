/**
 * The playlist's keyboard: the grid is one Tab stop with a cursor (see `timeline/key-cursor/keys.ts` for the keys). This
 * module connects the grid element to the cursor, the editing functions, the spoken sentences and the hidden description.
 */
import { lengthText, plural } from '../../../timeline/key-cursor/describe';
import { decodeKey, type KeyIntent } from '../../../timeline/key-cursor/keys';
import { KeyStack } from '../../../timeline/key-cursor/stack';
import type { CleanupList } from '../../../timeline/listeners';
import type { PlaylistContext } from './context';
import {
  adjustAtCursor,
  clearSelection,
  deleteAtCursor,
  insertAtCursor,
  resizeSelection,
  selectEveryClip,
  shiftSelection,
  toggleAtCursor,
} from './key-edit';
import { describeCursor, moveCursor, placeCursorOnFocus, revealCursor, summaryText } from './key-cursor';
import { currentProject, snapTicks } from './lanes';

/** What a screen reader says first when the grid gets the keyboard (the arrows and the keys that change clips). */
const HELP = 'Arrow keys move the cursor, Enter selects a clip or places the current pattern, Delete removes, Alt with arrows moves clips. Question mark says where you are.';

/** Everything that is not a plain move: the sentence to say for the edit, or null when the key is not used (it goes on to the app). */
function runEdit(ctx: PlaylistContext, intent: KeyIntent): string | null {
  switch (intent.kind) {
    case 'toggle':
      return toggleAtCursor(ctx);
    case 'insert':
      return insertAtCursor(ctx);
    case 'delete':
      return deleteAtCursor(ctx);
    case 'selectAll':
      return selectEveryClip(ctx);
    case 'clear':
      return clearSelection(ctx);
    case 'shift':
      return shiftSelection(ctx, intent);
    case 'resize':
      return resizeSelection(ctx, intent.direction);
    case 'adjust':
      return adjustAtCursor(ctx, intent.direction);
    default:
      return null;
  }
}

/** The long answer to the ? key: what the playlist holds, where the cursor is, the grid step, and a reminder of the keys. */
function fullDescription(ctx: PlaylistContext): string {
  const project = currentProject(ctx);
  const grid = lengthText(snapTicks(ctx, project), project.transport.timeSig);
  return `${summaryText(ctx)} Under the cursor: ${describeCursor(ctx)}. Grid step ${grid}. ${HELP}`;
}

/** Moves the cursor and returns what to say; with Shift it says how many clips are selected now. */
function runMove(ctx: PlaylistContext, intent: Extract<KeyIntent, { kind: 'move' | 'page' | 'edge' }>): string {
  moveCursor(ctx, intent);
  const sentence = describeCursor(ctx);
  if (!intent.isExtend) return sentence;
  return `${sentence}. ${plural(ctx.s.editor.getState().clipSelection.length, 'clip')} selected`;
}

/** Handles one key on the grid; true when it was used. */
function handleKey(ctx: PlaylistContext, stack: KeyStack, refresh: () => void, event: KeyboardEvent): boolean {
  const intent = decodeKey(event);
  if (!intent || ctx.state.drag) return false;
  if (intent.kind === 'describe') {
    stack.sayNow(fullDescription(ctx));
    return true;
  }
  const isMove = intent.kind === 'move' || intent.kind === 'page' || intent.kind === 'edge';
  if (!isMove) ctx.state.keyboard.anchor = null;
  const sentence = isMove ? runMove(ctx, intent) : runEdit(ctx, intent);
  if (sentence === null) return false;
  stack.say(sentence);
  ctx.invalidate('overlay');
  refresh();
  return true;
}

/** Makes the grid a keyboard stop with a cursor, and keeps its hidden description up to date. */
export function attachKeyboard(ctx: PlaylistContext, cleanups: CleanupList): void {
  const state = ctx.state.keyboard;
  let isRefreshQueued = false;
  const refresh = (): void => {
    if (isRefreshQueued) return;
    isRefreshQueued = true;
    queueMicrotask(() => {
      isRefreshQueued = false;
      stack.setSummary(summaryText(ctx));
    });
  };
  const stack: KeyStack = new KeyStack(ctx.s, ctx.els.gridHost, {
    label: 'Playlist grid',
    help: HELP,
    onKeyDown: (event) => handleKey(ctx, stack, refresh, event),
    onActiveChange: (isActive) => {
      state.isActive = isActive;
      if (!isActive) state.selectionWhenLeft = ctx.s.editor.getState().clipSelection;
      if (isActive) {
        placeCursorOnFocus(ctx);
        revealCursor(ctx);
        stack.setSummary(summaryText(ctx));
      }
      ctx.invalidate('overlay');
    },
  });
  stack.setSummary(summaryText(ctx));
  cleanups.add(
    () => stack.dispose(),
    ctx.s.doc.subscribe((next, prev) => {
      const now = next.project;
      const before = prev.project;
      if (now.playlist !== before.playlist || now.patterns !== before.patterns || now.channels !== before.channels) refresh();
    }),
    ctx.s.editor.subscribe((next, prev) => {
      if (next.clipSelection !== prev.clipSelection || next.openTakes !== prev.openTakes) refresh();
    }),
  );
}
