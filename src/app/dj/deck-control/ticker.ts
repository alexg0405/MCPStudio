/**
 * The decks' slow heartbeat (a few times a second): keeps each playing deck's window of audio moving with its
 * play position, publishes positions and meter levels into the state, and measures whether the audio keeps up.
 */
import { DECK_IDS, type DeckId, type DeckState } from '../decks-api';
import type { DeckContext } from './context';
import type { Positions } from './positions';
import { mapDecks } from './state';

/** How often the heartbeat runs (ms). */
const TICK_MS = 200;

/** Meter levels are rounded to 1/100, so a steady sound doesn't change the state (and redraw) on every tick. */
const LEVEL_STEPS_PER_UNIT = 100;

/** The audio clock is compared with the wall clock over at least this long (seconds) per keep-up reading. */
const KEEP_UP_WINDOW_SEC = 1;

/** The heartbeat of one set of decks. */
export interface Ticker {
  /** Starts it if it isn't running (and the decks aren't closed). */
  start(): void;
  /** Stops it. */
  stop(): void;
  /** How fast the audio kept up over the last second (1 = fully), or undefined while nothing plays. */
  keepUp(): number | undefined;
}

/** Makes the heartbeat of a set of decks (it starts when a deck plays). */
export function createTicker(context: DeckContext, positions: Positions): Ticker {
  const { store, runtime, now } = context;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  /** Wall time and audio time at the start of the current keep-up reading. */
  let keepUpSince: { wallMs: number; audioSec: number } | null = null;
  let keepUpValue: number | undefined;
  /** Peak levels of the four decks and the master (six slots, as `DeckGraph.readLevels` fills them). */
  const levelBuffer = new Float32Array(6);

  function start(): void {
    if (intervalId || context.isDisposed) return;
    intervalId = setInterval(tick, TICK_MS);
  }

  function stop(): void {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
  }

  function tick(): void {
    const graph = context.graph;
    if (!graph) return;
    const decks = store.getState().decks;
    const playingIds = DECK_IDS.filter((deckId) => decks[deckId].playing);
    measureKeepUp(playingIds.length > 0);
    if (playingIds.length === 0) {
      dropLevelsToZero(decks);
      return;
    }
    for (const deckId of playingIds) {
      const snapshot = graph.channel(DECK_IDS.indexOf(deckId)).snapshot();
      runtime[deckId].stream?.update(snapshot.pos, snapshot.rate);
    }
    graph.readLevels(levelBuffer);
    publishPositionsAndLevels();
  }

  /** Levels fall to nothing once nothing plays. */
  function dropLevelsToZero(decks: Record<DeckId, DeckState>): void {
    if (!DECK_IDS.some((deckId) => decks[deckId].level > 0)) return;
    store.setState((state) => ({ decks: mapDecks((deckId) => ({ ...state.decks[deckId], level: 0 })) }));
  }

  function publishPositionsAndLevels(): void {
    const tickAtMs = now();
    store.setState((state) => {
      const decks = { ...state.decks };
      for (const deckId of DECK_IDS) {
        const deck = decks[deckId];
        if (!deck.playing && deck.level === 0) continue;
        if (!deck.playing) {
          decks[deckId] = { ...deck, level: 0 };
          continue;
        }
        const peak = levelBuffer[DECK_IDS.indexOf(deckId)] as number;
        const level = Math.min(1, Math.round(peak * LEVEL_STEPS_PER_UNIT) / LEVEL_STEPS_PER_UNIT);
        decks[deckId] = { ...deck, level, positionSec: positions.positionNow(deckId), positionAt: tickAtMs };
      }
      return { decks };
    });
  }

  /**
   * Compares how far the audio clock advanced with how long the wall clock took: below 1, the page is too busy to
   * feed the audio thread in time. Needs a playing deck, and restarts whenever none plays.
   */
  function measureKeepUp(isAnyPlaying: boolean): void {
    const graph = context.graph;
    if (!graph || !isAnyPlaying) {
      keepUpSince = null;
      keepUpValue = undefined;
      return;
    }
    const wallMs = now();
    const audioSec = graph.ctx.currentTime;
    if (!keepUpSince) {
      keepUpSince = { wallMs, audioSec };
      return;
    }
    const wallSec = (wallMs - keepUpSince.wallMs) / 1000;
    if (wallSec < KEEP_UP_WINDOW_SEC) return;
    keepUpValue = Math.min(1, (audioSec - keepUpSince.audioSec) / wallSec);
    keepUpSince = { wallMs, audioSec };
  }

  return { start, stop, keepUp: () => keepUpValue };
}
