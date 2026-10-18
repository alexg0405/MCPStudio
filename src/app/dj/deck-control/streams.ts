/**
 * How a deck's song reaches its player: opening a song as a source (decoded whole, or read by parts), handing the
 * player the window of blocks, and telling the window which places to keep loaded (cue point, hot cues, loop).
 */
import { LONG_SONG_SEC, MAX_WHOLE_DECODE_SEC } from '@core/dj/long';
import type { SampleRef } from '@core/model/types';
import { yieldToMain } from '@engine/audio-buffers';
import type { DeckChannel, DeckGraph } from '@engine/deck/deck-graph';
import { bufferSource, blobReader, openSegmentSource, type DeckSource } from '@engine/deck/deck-source';
import { DeckStream, type PinnedPlace } from '@engine/deck/deck-stream';
import { SampleCache } from '@engine/samples';
import type { DeckId } from '../decks-api';
import type { DeckContext } from './context';

/** Files this big are opened by parts when they can be even if their length isn't known yet. */
const BIG_FILE_BYTES = 48 * 1024 * 1024;

/** What a hot cue keeps loaded after its point (seconds): enough to start playing while the rest of its place is read. */
const HOT_CUE_KEEP_SEC = 2.8;

/** A song opened for a deck: its source, and the decoded buffer when it was decoded whole (null when read by parts). */
export interface OpenedSong {
  source: DeckSource;
  buffer: AudioBuffer | null;
}

/** Tells a player about the song's window (the shared pool and block table). */
export function announceStream(channel: DeckChannel, stream: DeckStream): void {
  channel.send({
    t: 'stream',
    poolL: stream.poolL,
    poolR: stream.poolR,
    table: stream.table,
    frames: stream.frames,
    sampleRate: stream.sampleRate,
  });
}

/** What the audio side of a deck's song needs from the rest of the decks. */
export interface Streams {
  /** Opens a song: decoded whole through the cache, or read by parts when it is long and its file allows. */
  openSource(ref: SampleRef, title: string, graph: DeckGraph): Promise<OpenedSong>;
  /** Hands a deck's player the song's window (and puts it where it was, with its tempo, loop and play state). */
  sendStream(deckId: DeckId, stream: DeckStream, positionFrames: number): void;
  /** Reads the song again for a new audio context (another sample rate) and continues where the deck was. */
  reloadFor(deckId: DeckId, graph: DeckGraph): Promise<void>;
  /** Tells the window what the deck keeps loaded beyond its play position: the cue point, hot cues and an active loop. */
  refreshPins(deckId: DeckId): void;
  /** Tells the player to loop between two positions (seconds of the song). */
  sendLoop(deckId: DeckId, startSec: number, endSec: number): void;
}

/** Makes the song streaming of a set of decks. */
export function createStreams(context: DeckContext): Streams {
  const { deps, runtime, deckState, channelOf } = context;

  /**
   * How a song is read: short ones decoded whole through the shared cache (kept there, pinned while the deck has it), long
   * ones, when their file can be read by parts, straight from the file a few seconds at a time, so no memory goes
   * to more than the window. Files that can only be decoded whole are refused beyond `MAX_WHOLE_DECODE_SEC`.
   */
  async function openSource(ref: SampleRef, title: string, graph: DeckGraph): Promise<OpenedSong> {
    const rate = graph.ctx.sampleRate;
    const knownDurationSec = ref.durationSec ?? deps.cache.knownDuration(ref, rate);
    const isLong = knownDurationSec !== null && knownDurationSec > LONG_SONG_SEC;
    if (deps.openFile && (isLong || knownDurationSec === null)) {
      const blob = await deps.openFile(ref).catch(() => null);
      if (blob && (isLong || blob.size > BIG_FILE_BYTES)) {
        const source = await openSegmentSource({ reader: blobReader(blob), sampleRate: rate, yieldNow: yieldToMain }).catch(() => null);
        if (source) return { source, buffer: null };
      }
    }
    const tooLongError = () =>
      new Error(`“${title}” is longer than ${MAX_WHOLE_DECODE_SEC / 60} minutes and its format can’t be played in parts: use an MP3 or WAV of it.`);
    if (knownDurationSec !== null && knownDurationSec > MAX_WHOLE_DECODE_SEC) throw tooLongError();
    const buffer = await deps.cache.load(ref, graph.ctx);
    if (!buffer) throw new Error(`Couldn’t read “${title}” (it may have been removed from the library).`);
    if (buffer.duration > MAX_WHOLE_DECODE_SEC) throw tooLongError();
    // The decoded copy stays in the cache's budget but can't be evicted while the deck plays from it.
    const release = deps.cache.pin(SampleCache.keyOf(ref.source, rate));
    return { source: bufferSource(buffer, release), buffer };
  }

  function sendStream(deckId: DeckId, stream: DeckStream, positionFrames: number): void {
    const channel = channelOf(deckId);
    if (!channel) return;
    const deck = deckState(deckId);
    stream.moveTo(positionFrames);
    announceStream(channel, stream);
    channel.send({ t: 'tempo', rate: 1 + deck.pitch, keyLock: deck.keyLock });
    channel.send({ t: 'seek', pos: positionFrames });
    if (deck.loop?.active) sendLoop(deckId, deck.loop.startSec, deck.loop.endSec);
    if (deck.playing) channel.send({ t: 'play', on: true });
    refreshPins(deckId);
  }

  async function reloadFor(deckId: DeckId, graph: DeckGraph): Promise<void> {
    const deck = deckState(deckId);
    if (!deck.song) return;
    const deckRuntime = runtime[deckId];
    const loadToken = ++deckRuntime.loadToken;
    const oldStream = deckRuntime.stream;
    try {
      const { source } = await openSource(deck.song.ref, deck.song.title, graph);
      if (loadToken !== deckRuntime.loadToken || context.isDisposed) return void source.dispose();
      const stream = new DeckStream(source);
      deckRuntime.stream = stream;
      oldStream?.dispose();
      sendStream(deckId, stream, deckState(deckId).positionSec * stream.sampleRate);
    } catch (error) {
      if (loadToken === deckRuntime.loadToken) deps.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function refreshPins(deckId: DeckId): void {
    const stream = runtime[deckId].stream;
    const deck = deckState(deckId);
    if (!stream || !deck.song) return;
    const rate = stream.sampleRate;
    const places: PinnedPlace[] = [];
    const keepFrames = HOT_CUE_KEEP_SEC * rate;
    const pinFrom = (sec: number) =>
      places.push({ startFrame: Math.max(0, Math.round(sec * rate)), endFrame: Math.round(sec * rate + keepFrames) });
    if (deck.loop?.active && deck.loop.endSec > deck.loop.startSec) {
      places.push({ startFrame: Math.round(deck.loop.startSec * rate), endFrame: Math.round(deck.loop.endSec * rate) });
    }
    for (const hotCueSec of deck.hotCues) if (hotCueSec !== null) pinFrom(hotCueSec);
    pinFrom(deck.cuePoint);
    stream.setPins(places);
  }

  function sendLoop(deckId: DeckId, startSec: number, endSec: number): void {
    const rate = context.sampleRate();
    channelOf(deckId)?.send({ t: 'loop', start: startSec * rate, length: (endSec - startSec) * rate });
  }

  return { openSource, sendStream, reloadFor, refreshPins, sendLoop };
}
