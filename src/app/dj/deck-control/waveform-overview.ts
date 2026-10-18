/**
 * The waveform overview of a deck's song (the strip above the platter), filled a slice at a time so the page stays
 * free: from the decoded buffer, or, for a song read by parts, by reading it through once while it is already playable.
 */
import { fillPeaks, newWaveform, PEAK_BUCKET, type DeckWaveform } from '@core/dj/deck-peaks';
import { yieldToMain } from '@engine/audio-buffers';
import type { DeckSource } from '@engine/deck/deck-source';
import type { DeckId } from '../decks-api';
import type { DeckContext } from './context';

/** Peak buckets computed between two yields to the page when the song is in memory. */
const BUCKETS_PER_SLICE = 4096;

/** Peak buckets read per piece of a song read by parts (about 22 s of the song). */
const BUCKETS_PER_PIECE = 4096;

/** A song read by parts tells the drawing every this many pieces (and at the end), not after each. */
const PIECES_PER_REDRAW = 4;

/**
 * Fills the deck's overview. Resolves false if the deck loaded something else meanwhile (`isStale`), true when done.
 * For a song read by parts the overview is visible and growing as it goes.
 */
export async function fillOverview(
  context: DeckContext,
  deckId: DeckId,
  source: DeckSource,
  buffer: AudioBuffer | null,
  isStale: () => boolean,
): Promise<boolean> {
  const waveform = newWaveform(source.nativeFrames, source.nativeRate);
  if (buffer) return fillFromBuffer(context, deckId, waveform, buffer, isStale);
  return fillFromSource(context, deckId, waveform, source, isStale);
}

async function fillFromBuffer(
  context: DeckContext,
  deckId: DeckId,
  waveform: DeckWaveform,
  buffer: AudioBuffer,
  isStale: () => boolean,
): Promise<boolean> {
  const filterState = { lp: 0 };
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c));
  for (let bucket = 0; bucket < waveform.buckets; bucket += BUCKETS_PER_SLICE) {
    fillPeaks(waveform, channels, bucket, bucket + BUCKETS_PER_SLICE, filterState);
    if (bucket + BUCKETS_PER_SLICE < waveform.buckets) await yieldToMain();
    if (isStale()) return false;
  }
  context.runtime[deckId].waveform = waveform;
  context.patchDeck(deckId, {}); // wake subscribers: the waveform is there
  return true;
}

async function fillFromSource(
  context: DeckContext,
  deckId: DeckId,
  waveform: DeckWaveform,
  source: DeckSource,
  isStale: () => boolean,
): Promise<boolean> {
  const filterState = { lp: 0 };
  const left = new Float32Array(BUCKETS_PER_PIECE * PEAK_BUCKET);
  const right = new Float32Array(BUCKETS_PER_PIECE * PEAK_BUCKET);
  context.runtime[deckId].waveform = waveform;
  for (let bucket = 0, piece = 0; bucket < waveform.buckets; bucket += BUCKETS_PER_PIECE, piece++) {
    const startFrame = bucket * PEAK_BUCKET;
    const frames = Math.min(left.length, source.nativeFrames - startFrame);
    await source.readNative(startFrame, frames, left, right).catch(() => {});
    if (isStale()) return false;
    const channels = source.channels === 2 ? [left.subarray(0, frames), right.subarray(0, frames)] : [left.subarray(0, frames)];
    fillPeaks(waveform, channels, bucket, bucket + BUCKETS_PER_PIECE, filterState, startFrame);
    const isLastPiece = bucket + BUCKETS_PER_PIECE >= waveform.buckets;
    if (piece % PIECES_PER_REDRAW === PIECES_PER_REDRAW - 1 || isLastPiece) context.patchDeck(deckId, {});
    await yieldToMain();
  }
  return true;
}
