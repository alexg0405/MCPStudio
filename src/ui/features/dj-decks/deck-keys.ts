/**
 * The keys of the Decks window: they work only while the window has focus, so they never clash with the rest of the
 * app (a key scoped to a window wins there, and the letters below are not bound anywhere else). Deck A on the left
 * hand, deck B on the right.
 */
import type { DeckId } from '@app/dj/decks-api';
import type { Services } from '@app/services';

/** One deck's keys (`KeyboardEvent.code` style names): play, cue (hold), sync, key lock, four hot cues, loop, jump back and forward. */
interface DeckKeys {
  play: string;
  cue: string;
  sync: string;
  keyLock: string;
  hot: string[];
  loop: string;
  back: string;
  fwd: string;
}

const KEYS: Record<'A' | 'B', DeckKeys> = {
  A: { play: 'Q', cue: 'W', sync: 'E', keyLock: 'T', hot: ['A', 'S', 'D', 'F'], loop: 'Z', back: 'X', fwd: 'C' },
  B: { play: 'U', cue: 'I', sync: 'O', keyLock: 'P', hot: ['H', 'J', 'K', 'Semicolon'], loop: 'M', back: 'Comma', fwd: 'Period' },
};

/** Physical keys (event.code) whose release ends a cue preview. */
const CUE_CODES: Record<string, DeckId> = { KeyW: 'A', KeyI: 'B' };

/** How far an arrow key moves the crossfader (−1…1 scale). */
const CROSSFADER_KEY_STEP = 0.05;

/** Adds the deck key bindings, and the key-up listener that ends a cue preview. `windowType` is the Decks window. */
export function registerDeckKeys(services: Services, windowType: string): void {
  const when = { focus: [windowType] } as const;
  for (const deck of ['A', 'B'] as const) {
    const k = KEYS[deck];
    services.keymap.add([
      { chord: k.play, command: 'decks.play', args: deck, when },
      { chord: k.cue, command: 'decks.cue', args: deck, when },
      { chord: k.sync, command: 'decks.sync', args: deck, when },
      { chord: k.keyLock, command: 'decks.keyLock', args: deck, when },
      { chord: k.loop, command: 'decks.loop', args: deck, when },
      { chord: k.back, command: 'decks.jump', args: { deck, direction: -1 }, when },
      { chord: k.fwd, command: 'decks.jump', args: { deck, direction: 1 }, when },
      ...k.hot.map((chord, index) => ({ chord, command: 'decks.hotCue', args: { deck, index }, when })),
    ]);
  }
  services.keymap.add([
    { chord: 'ArrowLeft', command: 'decks.crossfader', args: -CROSSFADER_KEY_STEP, when, repeat: true },
    { chord: 'ArrowRight', command: 'decks.crossfader', args: CROSSFADER_KEY_STEP, when, repeat: true },
    { chord: 'Home', command: 'decks.crossfader', args: 'A', when },
    { chord: 'End', command: 'decks.crossfader', args: 'B', when },
  ]);
  endCuePreviewOnKeyUp(services, windowType);
}

/** Letting go of a cue key ends its preview (the keymap only sees key presses). */
function endCuePreviewOnKeyUp(services: Services, windowType: string): void {
  if (typeof window === 'undefined') return;
  window.addEventListener(
    'keyup',
    (e) => {
      const deck = CUE_CODES[e.code];
      if (!deck) return;
      const view = services.view.getState();
      const focused = view.focusedId ? view.windows[view.focusedId]?.type : null;
      if (focused === windowType) void services.decks().then((decks) => decks.cueUp(deck));
    },
    true,
  );
}
