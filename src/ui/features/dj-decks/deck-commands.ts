/**
 * The commands of the live decks (play, cue, sync, hot cues, loop, jump, crossfader, record). Each takes a deck
 * as its argument, so keys, controllers and the Studio can all drive them; the keys are in `deck-keys.ts`.
 */
import { DECK_IDS, type DeckId } from '@app/dj/decks-api';
import type { Services } from '@app/services';

/** The hint every command that takes a deck gives for its argument. */
const DECK_ARG_HINT = "a deck: 'A', 'B', 'C' or 'D'";

/** Where the 'A' and 'B' arguments put the crossfader (all the way to that side). */
const CROSSFADER_SIDE = { A: -1, B: 1 } as const;

/** A loop of this many beats is what the loop key makes. */
const KEY_LOOP_BEATS = 4;

const isDeck = (x: unknown): x is DeckId => typeof x === 'string' && (DECK_IDS as readonly string[]).includes(x);

/** The deck in a command argument: the deck itself, or `{ deck }`. */
function deckArg(arg: unknown): DeckId | null {
  if (isDeck(arg)) return arg;
  const inner = (arg as { deck?: unknown } | null)?.deck;
  return isDeck(inner) ? inner : null;
}

/** Registers the deck commands. */
export function registerDeckCommands(services: Services): void {
  const { commands } = services;
  const decksOf = async () => services.decks();

  commands.register<DeckId>({
    id: 'decks.play',
    title: 'Deck play or pause',
    category: 'DJ',
    hint: 'Start or pause a deck (the Decks window shortcut: Q for deck A, U for deck B)',
    argsHint: DECK_ARG_HINT,
    palette: false,
    ai: false,
    run: async (_s, deck) => {
      if (isDeck(deck)) (await decksOf()).togglePlay(deck);
    },
  });
  commands.register<DeckId>({
    id: 'decks.cue',
    title: 'Deck cue',
    category: 'DJ',
    hint: 'Cue: paused, set the cue point on the beat and play from it while held; playing, return to the cue point and pause',
    argsHint: DECK_ARG_HINT,
    palette: false,
    run: async (_s, deck) => {
      if (isDeck(deck)) (await decksOf()).cueDown(deck);
    },
  });
  commands.register<DeckId>({
    id: 'decks.sync',
    title: 'Deck sync',
    category: 'DJ',
    hint: 'Match this deck’s tempo and beat to the other deck and keep them together; again to let go',
    argsHint: DECK_ARG_HINT,
    palette: false,
    ai: false,
    run: async (_s, deck) => {
      if (isDeck(deck)) (await decksOf()).sync(deck);
    },
  });
  commands.register<DeckId>({
    id: 'decks.keyLock',
    title: 'Deck key lock',
    category: 'DJ',
    hint: 'Key lock: change a deck’s tempo without changing its pitch',
    argsHint: DECK_ARG_HINT,
    palette: false,
    ai: false,
    run: async (_s, deck) => {
      if (!isDeck(deck)) return;
      const decks = await decksOf();
      decks.setKeyLock(deck, !decks.store.getState().decks[deck].keyLock);
    },
  });
  commands.register<{ deck: DeckId; index: number }>({
    id: 'decks.hotCue',
    title: 'Deck hot cue',
    category: 'DJ',
    hint: 'Hot cue: the first press sets a marker at the playhead, the next jumps back to it and plays',
    argsHint: '{ deck: A–D, index: 0–7 }',
    palette: false,
    run: async (_s, arg) => {
      const deck = deckArg(arg);
      if (deck && typeof arg?.index === 'number') (await decksOf()).hotCue(deck, arg.index);
    },
  });
  commands.register<DeckId>({
    id: 'decks.loop',
    title: 'Deck loop',
    category: 'DJ',
    hint: 'Loop four beats from the beat under the playhead; again to leave the loop',
    argsHint: DECK_ARG_HINT,
    palette: false,
    ai: false,
    run: async (_s, deck) => {
      if (isDeck(deck)) (await decksOf()).autoLoop(deck, KEY_LOOP_BEATS);
    },
  });
  commands.register<{ deck: DeckId; direction: 1 | -1 }>({
    id: 'decks.jump',
    title: 'Deck beat jump',
    category: 'DJ',
    hint: 'Jump a deck forward or back by its beat-jump size (beats), keeping the beat',
    argsHint: '{ deck: A–D, direction: 1 or -1 }',
    palette: false,
    run: async (_s, arg) => {
      const deck = deckArg(arg);
      if (!deck) return;
      const decks = await decksOf();
      const direction = arg?.direction === -1 ? -1 : 1;
      decks.beatJumpBy(deck, direction * decks.store.getState().decks[deck].beatJump);
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
    run: async (_s, arg) => {
      const decks = await decksOf();
      const current = decks.store.getState().crossfader;
      if (arg === 'A' || arg === 'B') decks.setCrossfader(CROSSFADER_SIDE[arg]);
      else decks.setCrossfader(typeof arg === 'number' ? current + arg : current);
    },
  });
  commands.register({
    id: 'decks.record',
    title: 'Record the live mix',
    category: 'DJ',
    hint: 'Start or stop recording what the decks play; the recording is added to your music library as “Live mix …”',
    run: async (s) => {
      const decks = await decksOf();
      try {
        if (decks.store.getState().recording) {
          const title = await decks.stopRecording();
          if (title) s.session.getState().toast(`Saved “${title}” in your music library.`);
        } else {
          await decks.startRecording();
          s.session.getState().toast('Recording the decks. Press Record the live mix again to stop.');
        }
      } catch (e) {
        s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
      }
    },
  });
}
