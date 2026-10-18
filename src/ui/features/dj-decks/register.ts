import type { Services } from '@app/services';
import { addActionProvider } from '../../shell/actions';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { lazyWindow } from '../../workspace/lazy';
import { registerDeckCommands } from './deck-commands';
import { registerDeckKeys } from './deck-keys';

/** The window type of the Decks window. */
export const DECKS_WINDOW = 'dj-decks';

/** The Decks window opens this big (px) when the workspace has room: wide enough for two decks and the mixer. */
const WINDOW_WIDTH_PX = 1120;
const WINDOW_HEIGHT_PX = 640;
/** It never gets smaller than this. */
const WINDOW_MIN_SIZE = { w: 760, h: 420 };
/** Gap kept at the top of the workspace when it opens (px). */
const WINDOW_TOP_PX = 30;

/** Registers the Decks window, its commands and keys, its menu entry and its help. */
export function register(services: Services): void {
  registerWindowType({
    type: DECKS_WINDOW,
    title: () => 'DJ decks',
    component: lazyWindow(() => import('./DecksWindow'), (m) => m.DecksWindow),
    defaultRect: (ws) => ({
      x: Math.max(0, Math.round(ws.w / 2 - WINDOW_WIDTH_PX / 2)),
      y: WINDOW_TOP_PX,
      w: Math.min(WINDOW_WIDTH_PX, ws.w),
      h: Math.min(WINDOW_HEIGHT_PX, ws.h - WINDOW_TOP_PX - 10),
    }),
    minSize: WINDOW_MIN_SIZE,
  });
  registerWindowToggle(services, {
    command: 'decks.open',
    type: DECKS_WINDOW,
    title: 'DJ decks',
    hint: 'Play songs live on two decks (four on request) with a mixer: sync, loops, cues, EQ, crossfader and a recorder',
    chords: ['Alt+D'],
    menuOrder: 58,
  });

  registerDeckCommands(services);
  registerDeckKeys(services, DECKS_WINDOW);

  addActionProvider('decks', (s) => [
    {
      key: 'decks.live',
      label: 'Play songs live on the DJ decks',
      path: ['View', 'DJ decks'],
      hint: 'Two decks with a mixer: load songs from your music library, sync them, loop, cue, EQ and crossfade',
      keywords: ['dj', 'decks', 'turntable', 'cdj', 'live', 'mix', 'crossfade', 'sync', 'scratch', 'hot cue', 'loop', 'record'],
      run: () => void s.commands.run('decks.open'),
    },
  ]);

  setWindowHelp(DECKS_WINDOW, {
    intro:
      'Play your own songs live: load one on each deck, press play, sync the tempos and blend with the crossfader. Nothing here is part of your project.',
    moves: [
      ['Load a song', 'Drag one from the Music list onto a deck, press Load…, or right-click a song and choose Load to deck A or B'],
      ['Play / CUE', 'Play starts and pauses. CUE (hold) previews from the cue point; paused, it sets the cue point on the beat'],
      ['SYNC', 'Matches this deck’s tempo and beat to the other deck and keeps them locked; moving the pitch fader lets go'],
      ['KEY LOCK', 'Changes the tempo without changing the pitch (off, the pitch follows the speed like a record)'],
      ['Platter', 'Drag to scratch, drag the outer ring (or scroll) to nudge the tempo; click the long strip to jump around the song'],
      ['Hot cues 1–8', 'The first click on an empty pad sets a marker on the beat, the next jumps to it and plays; right-click clears'],
      ['Loops', 'IN and OUT set a loop by hand, 1/4 to 32 pick a loop of that many beats, ½ and 2× resize it, ◀ ▶ jump by beats'],
      ['EQ and filter', 'Turn Low, Mid or High all the way down to kill a band; the filter closes (left) or thins (right) the sound'],
      ['Crossfader', 'Blends side A with side B; a deck’s side is chosen under its knobs. ← → move it, Home and End go to one side'],
      ['CUE (headphones)', 'Pick your headphones at the top, then press HEAD under a deck to hear it before the room does'],
      ['Rec', 'Records everything you hear; the mix is added to your music library as “Live mix …”'],
      ['Keys', 'Deck A: Q play, W cue, E sync, T key lock, A S D F hot cues, Z loop, X C jump. Deck B: U I O P, H J K ; M , .'],
    ],
  });
}
