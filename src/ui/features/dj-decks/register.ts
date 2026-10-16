import type { DeckId } from '@app/dj/decks-api';
import { DECK_IDS } from '@app/dj/decks-api';
import type { Services } from '@app/services';
import { addActionProvider } from '../../shell/actions';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { setWindowHelp } from '../../workspace/window-help';
import { lazyWindow } from '../../workspace/lazy';

/** The window type of the Decks window. */
export const DECKS_WINDOW = 'dj-decks';

const isDeck = (x: unknown): x is DeckId => typeof x === 'string' && (DECK_IDS as readonly string[]).includes(x);

/**
 * Keys while the Decks window has focus (they never clash with the rest of the app: a key scoped to a window wins
 * there, and the letters below are not bound anywhere else). Deck A on the left hand, deck B on the right.
 *   play, cue (hold), sync, key lock; four hot cues; loop of 4 beats, jump back, jump forward.
 */
const KEYS: Record<'A' | 'B', { play: string; cue: string; sync: string; keyLock: string; hot: string[]; loop: string; back: string; fwd: string }> = {
  A: { play: 'Q', cue: 'W', sync: 'E', keyLock: 'T', hot: ['A', 'S', 'D', 'F'], loop: 'Z', back: 'X', fwd: 'C' },
  B: { play: 'U', cue: 'I', sync: 'O', keyLock: 'P', hot: ['H', 'J', 'K', 'Semicolon'], loop: 'M', back: 'Comma', fwd: 'Period' },
};
/** Physical keys (event.code) whose release ends a cue preview. */
const CUE_CODES: Record<string, DeckId> = { KeyW: 'A', KeyI: 'B' };

export function register(services: Services): void {
  registerWindowType({
    type: DECKS_WINDOW,
    title: () => 'DJ decks',
    component: lazyWindow(() => import('./DecksWindow'), (m) => m.DecksWindow),
    defaultRect: (ws) => ({
      x: Math.max(0, Math.round(ws.w / 2 - 560)),
      y: 30,
      w: Math.min(1120, ws.w),
      h: Math.min(640, ws.h - 40),
    }),
    minSize: { w: 760, h: 420 },
  });
  registerWindowToggle(services, {
    command: 'decks.open',
    type: DECKS_WINDOW,
    title: 'DJ decks',
    hint: 'Play songs live on two decks (four on request) with a mixer: sync, loops, cues, EQ, crossfader and a recorder',
    chords: ['Alt+D'],
    menuOrder: 58,
  });

  const { commands, keymap } = services;
  const decksOf = async () => services.decks();
  const deckArg = (a: unknown): DeckId | null => (isDeck(a) ? a : isDeck((a as { deck?: unknown } | null)?.deck) ? (a as { deck: DeckId }).deck : null);

  commands.register<DeckId>({
    id: 'decks.play',
    title: 'Deck play or pause',
    category: 'DJ',
    hint: 'Start or pause a deck (the Decks window shortcut: Q for deck A, U for deck B)',
    argsHint: "a deck: 'A', 'B', 'C' or 'D'",
    palette: false,
    ai: false,
    run: async (_s, a) => {
      if (isDeck(a)) (await decksOf()).togglePlay(a);
    },
  });
  commands.register<DeckId>({
    id: 'decks.cue',
    title: 'Deck cue',
    category: 'DJ',
    hint: 'Cue: paused, set the cue point on the beat and play from it while held; playing, return to the cue point and pause',
    argsHint: "a deck: 'A', 'B', 'C' or 'D'",
    palette: false,
    ai: false,
    run: async (_s, a) => {
      if (isDeck(a)) (await decksOf()).cueDown(a);
    },
  });
  commands.register<DeckId>({
    id: 'decks.sync',
    title: 'Deck sync',
    category: 'DJ',
    hint: 'Match this deck’s tempo and beat to the other deck and keep them together; again to let go',
    argsHint: "a deck: 'A', 'B', 'C' or 'D'",
    palette: false,
    ai: false,
    run: async (_s, a) => {
      if (isDeck(a)) (await decksOf()).sync(a);
    },
  });
  commands.register<DeckId>({
    id: 'decks.keyLock',
    title: 'Deck key lock',
    category: 'DJ',
    hint: 'Key lock: change a deck’s tempo without changing its pitch',
    argsHint: "a deck: 'A', 'B', 'C' or 'D'",
    palette: false,
    ai: false,
    run: async (_s, a) => {
      if (!isDeck(a)) return;
      const d = await decksOf();
      d.setKeyLock(a, !d.store.getState().decks[a].keyLock);
    },
  });
  commands.register<{ deck: DeckId; index: number }>({
    id: 'decks.hotCue',
    title: 'Deck hot cue',
    category: 'DJ',
    hint: 'Hot cue: the first press sets a marker at the playhead, the next jumps back to it and plays',
    argsHint: '{ deck: A–D, index: 0–7 }',
    palette: false,
    ai: false,
    run: async (_s, a) => {
      const deck = deckArg(a);
      if (deck && typeof a?.index === 'number') (await decksOf()).hotCue(deck, a.index);
    },
  });
  commands.register<DeckId>({
    id: 'decks.loop',
    title: 'Deck loop',
    category: 'DJ',
    hint: 'Loop four beats from the beat under the playhead; again to leave the loop',
    argsHint: "a deck: 'A', 'B', 'C' or 'D'",
    palette: false,
    ai: false,
    run: async (_s, a) => {
      if (isDeck(a)) (await decksOf()).autoLoop(a, 4);
    },
  });
  commands.register<{ deck: DeckId; direction: 1 | -1 }>({
    id: 'decks.jump',
    title: 'Deck beat jump',
    category: 'DJ',
    hint: 'Jump a deck forward or back by its beat-jump size (beats), keeping the beat',
    argsHint: '{ deck: A–D, direction: 1 or -1 }',
    palette: false,
    ai: false,
    run: async (_s, a) => {
      const deck = deckArg(a);
      if (!deck) return;
      const d = await decksOf();
      d.beatJumpBy(deck, (a?.direction === -1 ? -1 : 1) * d.store.getState().decks[deck].beatJump);
    },
  });
  commands.register<number | 'A' | 'B'>({
    id: 'decks.crossfader',
    title: 'Crossfader move',
    category: 'DJ',
    hint: 'Move the crossfader a step toward A or B (a number), or all the way to one side (A or B)',
    argsHint: "a step like -0.1 or 0.1, or 'A' / 'B'",
    palette: false,
    ai: false,
    run: async (_s, a) => {
      const d = await decksOf();
      const now = d.store.getState().crossfader;
      d.setCrossfader(a === 'A' ? -1 : a === 'B' ? 1 : typeof a === 'number' ? now + a : now);
    },
  });
  commands.register({
    id: 'decks.record',
    title: 'Record the live mix',
    category: 'DJ',
    hint: 'Start or stop recording what the decks play; the recording is added to your music library as “Live mix …”',
    run: async (s) => {
      const d = await decksOf();
      try {
        if (d.store.getState().recording) {
          const title = await d.stopRecording();
          if (title) s.session.getState().toast(`Saved “${title}” in your music library.`);
        } else {
          await d.startRecording();
          s.session.getState().toast('Recording the decks. Press Record the live mix again to stop.');
        }
      } catch (e) {
        s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
      }
    },
  });

  // Key bindings, only while the Decks window has focus.
  const when = { focus: [DECKS_WINDOW] } as const;
  for (const deck of ['A', 'B'] as const) {
    const k = KEYS[deck];
    keymap.add([
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
  keymap.add([
    { chord: 'ArrowLeft', command: 'decks.crossfader', args: -0.05, when, repeat: true },
    { chord: 'ArrowRight', command: 'decks.crossfader', args: 0.05, when, repeat: true },
    { chord: 'Home', command: 'decks.crossfader', args: 'A', when },
    { chord: 'End', command: 'decks.crossfader', args: 'B', when },
  ]);

  // Letting go of a cue key ends its preview (the keymap only sees key presses).
  if (typeof window !== 'undefined') {
    window.addEventListener(
      'keyup',
      (e) => {
        const deck = CUE_CODES[e.code];
        if (!deck) return;
        const v = services.view.getState();
        const focused = v.focusedId ? v.windows[v.focusedId]?.type : null;
        if (focused === DECKS_WINDOW) void services.decks().then((d) => d.cueUp(deck));
      },
      true,
    );
  }

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
