/**
 * The decks' starting state, and what a deck looks like with nothing loaded. Deck state is live performance state
 * (not in the project, not in History); see `decks-api.ts` for what each field means.
 */
import { DECK_IDS, HOT_CUES, type DeckId, type DeckState, type DecksState } from '../decks-api';

/** A pitch fader that spans ±8 %: the usual turntable range. */
const DEFAULT_PITCH_RANGE = 0.08;
/** Beats per beat-jump button press until the DJ picks another size. */
const DEFAULT_BEAT_JUMP_BEATS = 4;
/** Two decks are shown until the DJ asks for four. */
const DEFAULT_DECK_COUNT = 2;

/** A hot-cue row with every pad unset. */
export function unsetHotCues(): (number | null)[] {
  return Array.from({ length: HOT_CUES }, () => null);
}

/** A deck with no song and every knob at rest. */
export function emptyDeck(deckId: DeckId): DeckState {
  return {
    id: deckId,
    song: null,
    loading: false,
    playing: false,
    positionSec: 0,
    positionAt: 0,
    baseBpm: null,
    bpm: null,
    analyzing: null,
    pitch: 0,
    pitchRange: DEFAULT_PITCH_RANGE,
    keyLock: false,
    synced: false,
    volume: 1,
    trimDb: 0,
    eq: { low: 0, mid: 0, high: 0 },
    filter: 0,
    cueListen: false,
    cuePoint: 0,
    hotCues: unsetHotCues(),
    loop: null,
    beatJump: DEFAULT_BEAT_JUMP_BEATS,
    level: 0,
  };
}

/** The whole decks state at start (and after `dispose`): four empty decks, two shown, the crossfader centred on A. */
export function initialDecksState(): DecksState {
  return {
    decks: { A: emptyDeck('A'), B: emptyDeck('B'), C: emptyDeck('C'), D: emptyDeck('D') },
    deckCount: DEFAULT_DECK_COUNT,
    crossfader: 0,
    crossfaderAssign: { A: 'A', B: 'B', C: 'thru', D: 'thru' },
    crossfaderCurve: 'smooth',
    masterVolume: 1,
    recording: null,
  };
}

/**
 * A deck with nothing loaded: the mixer settings (knobs, faders, key lock) stay, the song's things go. `extra` is
 * applied on top (the loading state of a song just picked).
 */
export function blankDeck(current: DeckState, extra: Partial<DeckState> = {}): DeckState {
  return {
    ...emptyDeck(current.id),
    eq: current.eq,
    filter: current.filter,
    volume: current.volume,
    trimDb: current.trimDb,
    cueListen: current.cueListen,
    keyLock: current.keyLock,
    pitchRange: current.pitchRange,
    beatJump: current.beatJump,
    ...extra,
  };
}

/** One value per deck, as a record keyed by deck id (the shape of `DecksState.decks`). */
export function mapDecks<T>(make: (deckId: DeckId) => T): Record<DeckId, T> {
  return Object.fromEntries(DECK_IDS.map((deckId) => [deckId, make(deckId)])) as Record<DeckId, T>;
}
