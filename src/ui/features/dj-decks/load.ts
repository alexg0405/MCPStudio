import type { DeckId } from '@app/dj/decks-api';
import type { LibrarySong } from '@app/dj/library';
import type { Services } from '@app/services';
import type { MenuEntry } from '../../controls/ContextMenu';
import { openWindow } from '../../workspace/registry';

/** Dragging a song out of the music list (or the DJ window's table) carries its library key under this type. */
export const SONG_DRAG_TYPE = 'text/x-ag-song';

/** Opens the Decks window and puts a library song on a deck (a problem comes up as a message, not a crash). */
export async function loadToDeck(services: Services, song: LibrarySong, deck: DeckId): Promise<void> {
  openWindow(services, 'dj-decks');
  try {
    const decks = await services.decks();
    await decks.load(deck, song.ref, song.title, song.artist);
  } catch (e) {
    services.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
  }
}

/** The right-click entries that put a song on a deck. */
export function loadToDeckMenu(services: Services, song: LibrarySong): MenuEntry[] {
  const item = (deck: DeckId): MenuEntry => ({
    label: `Load to deck ${deck}`,
    hint: `Put “${song.label}” on deck ${deck} in the Decks window, ready to play`,
    onSelect: () => void loadToDeck(services, song, deck),
  });
  return [
    item('A'),
    item('B'),
    { kind: 'submenu', label: 'Load to another deck', hint: 'Decks C and D (show four decks in the Decks window)', items: [item('C'), item('D')] },
  ];
}
