/**
 * Cues: the CDJ-style cue button and the hot cue pads. Cue points and hot cues are saved per song, so they are still
 * there the next time the song is loaded.
 */
import { cuePressPlan, hotCuePosition } from '@core/dj/decks-math';
import { HOT_CUES, type DeckId } from '../decks-api';
import type { DeckContext } from './context';
import type { Positions } from './positions';
import type { Streams } from './streams';
import type { Transport } from './transport';

/** The cue and hot cue controls of one set of decks. */
export interface Cues {
  /** CDJ-style cue: paused, sets the cue point here; playing, returns to it and pauses; held, previews from it. */
  cueDown(deckId: DeckId): void;
  /** Lets go of the cue button: a preview stops and the deck returns to the cue point. */
  cueUp(deckId: DeckId): void;
  /** Hot cue pad `padIndex` (0-based): sets it when empty, jumps there (and plays) when set. */
  hotCue(deckId: DeckId, padIndex: number): void;
  clearHotCue(deckId: DeckId, padIndex: number): void;
}

/** Makes the cue and hot cue controls of a set of decks. */
export function createCues(context: DeckContext, positions: Positions, streams: Streams, transport: Transport): Cues {
  const { deps, runtime, deckState, patchDeck, channelOf } = context;

  /** Keeps the deck's cue point and hot cues for the next time its song is loaded. */
  function saveCues(deckId: DeckId): void {
    const songHash = runtime[deckId].songHash;
    if (!songHash || !deps.cues) return;
    const deck = deckState(deckId);
    deps.cues.save(songHash, { cuePoint: deck.cuePoint, hotCues: deck.hotCues });
  }

  function cueDown(deckId: DeckId): void {
    const deck = deckState(deckId);
    if (!deck.song) return;
    const plan = cuePressPlan({
      playing: deck.playing,
      positionSec: positions.positionNow(deckId),
      cuePoint: deck.cuePoint,
      grid: runtime[deckId].grid,
    });
    if (plan.setCue !== undefined) {
      patchDeck(deckId, { cuePoint: plan.setCue });
      saveCues(deckId);
      streams.refreshPins(deckId);
    }
    if (plan.pause) {
      runtime[deckId].isPreviewingCue = false;
      channelOf(deckId)?.send({ t: 'play', on: false });
      patchDeck(deckId, { playing: false });
    }
    if (plan.seek !== undefined) transport.seek(deckId, plan.seek);
    if (plan.preview) {
      transport.play(deckId);
      runtime[deckId].isPreviewingCue = true;
    }
  }

  function cueUp(deckId: DeckId): void {
    const deckRuntime = runtime[deckId];
    if (!deckRuntime.isPreviewingCue) return;
    deckRuntime.isPreviewingCue = false;
    channelOf(deckId)?.send({ t: 'play', on: false });
    patchDeck(deckId, { playing: false });
    transport.seek(deckId, deckState(deckId).cuePoint);
  }

  /** Stores a new hot cue row, keeps it, and tells the window to keep the pads' places loaded. */
  function setHotCues(deckId: DeckId, hotCues: (number | null)[]): void {
    patchDeck(deckId, { hotCues });
    saveCues(deckId);
    streams.refreshPins(deckId);
  }

  function hotCue(deckId: DeckId, padIndex: number): void {
    const deck = deckState(deckId);
    if (!deck.song || padIndex < 0 || padIndex >= HOT_CUES) return;
    const cueSec = deck.hotCues[padIndex];
    if (cueSec === null || cueSec === undefined) {
      const hotCues = deck.hotCues.slice();
      hotCues[padIndex] = Math.min(hotCuePosition(positions.positionNow(deckId), runtime[deckId].grid), deck.song.durationSec);
      setHotCues(deckId, hotCues);
      return;
    }
    transport.seek(deckId, cueSec);
    if (!deck.playing) transport.play(deckId);
  }

  function clearHotCue(deckId: DeckId, padIndex: number): void {
    const deck = deckState(deckId);
    if (padIndex < 0 || padIndex >= HOT_CUES || deck.hotCues[padIndex] === null) return;
    const hotCues = deck.hotCues.slice();
    hotCues[padIndex] = null;
    setHotCues(deckId, hotCues);
  }

  return { cueDown, cueUp, hotCue, clearHotCue };
}
