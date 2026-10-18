/**
 * The pointer gestures of a deck panel, as hooks that return event handlers: dragging the platter, seeking on the
 * overview, dropping a song on the deck and the "Load…" menu. They talk to the decks API directly; nothing here
 * re-renders the panel.
 */
import { useRef, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { DeckId, DecksApi } from '@app/dj/decks-api';
import { library, loadLibrary, pickSongFiles } from '@app/dj/library';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { useServices } from '../../services-context';
import { loadToDeck, SONG_DRAG_TYPE } from './load';
import type { DeckView } from './use-decks';

/** Where on the platter a drag starts, as a share of its radius: the outer ring nudges the tempo, the rest scratches. */
const PLATTER_RIM_START = 0.78;

/** A wheel notch nudges the tempo by this many platter revolutions (the wheel scrolls up for faster). */
const WHEEL_REVOLUTIONS_PER_PIXEL = 0.002;

/** The most songs the "Load…" menu lists. */
const MAX_LOAD_MENU_SONGS = 80;

/** How far below the "Load…" button its menu opens (px). */
const LOAD_MENU_GAP_PX = 4;

/** The handlers to put on the platter element. */
export interface PlatterHandlers {
  onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLDivElement>): void;
  onWheel(e: { deltaY: number }): void;
}

/** The angle (radians) of the pointer around the centre of the element. */
function pointerAngle(e: ReactPointerEvent<HTMLElement>): number {
  const box = e.currentTarget.getBoundingClientRect();
  return Math.atan2(e.clientY - (box.top + box.height / 2), e.clientX - (box.left + box.width / 2));
}

/** Platter: drag to scratch, the outer ring to nudge, the wheel to nudge. */
export function usePlatterGesture(api: DecksApi, deckId: DeckId, hasSong: boolean): PlatterHandlers {
  const drag = useRef<{ angle: number; mode: 'scratch' | 'nudge' } | null>(null);
  return {
    onPointerDown(e) {
      if (!hasSong || e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const box = e.currentTarget.getBoundingClientRect();
      const distance = Math.hypot(e.clientX - (box.left + box.width / 2), e.clientY - (box.top + box.height / 2)) / (box.width / 2);
      const mode = distance >= PLATTER_RIM_START ? 'nudge' : 'scratch';
      drag.current = { angle: pointerAngle(e), mode };
      if (mode === 'scratch') api.jogTouch(deckId, true);
    },
    onPointerMove(e) {
      const current = drag.current;
      if (!current) return;
      const angle = pointerAngle(e);
      let turn = angle - current.angle;
      // The angle wraps from +π to −π where the pointer crosses the left side: take the short way round.
      if (turn > Math.PI) turn -= 2 * Math.PI;
      if (turn < -Math.PI) turn += 2 * Math.PI;
      current.angle = angle;
      api.jog(deckId, turn / (2 * Math.PI), current.mode);
    },
    onPointerUp(e) {
      const current = drag.current;
      if (!current) return;
      drag.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      if (current.mode === 'scratch') api.jogTouch(deckId, false);
    },
    onWheel(e) {
      if (hasSong) api.jog(deckId, e.deltaY * -WHEEL_REVOLUTIONS_PER_PIXEL, 'nudge');
    },
  };
}

/** The handlers to put on the overview canvas. */
export interface OverviewHandlers {
  onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>): void;
}

/** Overview: click or drag to jump to that place in the song. */
export function useOverviewSeek(api: DecksApi, deckId: DeckId, song: DeckView['song']): OverviewHandlers {
  const isDragging = useRef(false);
  const seekTo = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!song) return;
    const box = e.currentTarget.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    api.seek(deckId, share * song.durationSec);
  };
  return {
    onPointerDown(e) {
      isDragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      seekTo(e);
    },
    onPointerMove(e) {
      if (isDragging.current) seekTo(e);
    },
    onPointerUp(e) {
      isDragging.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
  };
}

/** Loading by drag and drop: a song dragged from the Music list lands on the deck. */
export function useSongDrop(deckId: DeckId): { onDragOver(e: DragEvent): void; onDrop(e: DragEvent): void } {
  const services = useServices();
  return {
    onDragOver(e) {
      if (!e.dataTransfer.types.includes(SONG_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    },
    onDrop(e) {
      const key = e.dataTransfer.getData(SONG_DRAG_TYPE);
      if (!key) return;
      e.preventDefault();
      const song = library.getState().songs.find((x) => x.key === key);
      if (song) void loadToDeck(services, song, deckId);
    },
  };
}

/** The "Load…" button's menu of library songs (or a way to add some when the library is empty). */
export function useLoadMenu(deckId: DeckId): (e: ReactMouseEvent<HTMLElement>) => Promise<void> {
  const services = useServices();
  return async (e) => {
    const button = e.currentTarget.getBoundingClientRect();
    await loadLibrary();
    const songs = library.getState().songs;
    const items: MenuEntry[] =
      songs.length === 0
        ? [{ label: 'Add music files…', hint: 'Your music library is empty: add some song files to play', onSelect: () => void pickSongFiles(services) }]
        : songs
            .slice(0, MAX_LOAD_MENU_SONGS)
            .map((song) => ({ label: song.label, hint: `Put “${song.label}” on deck ${deckId}`, onSelect: () => void loadToDeck(services, song, deckId) }));
    showContextMenu({ x: button.left, y: button.bottom + LOAD_MENU_GAP_PX }, items);
  };
}
