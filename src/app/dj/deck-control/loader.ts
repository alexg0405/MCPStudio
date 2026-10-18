/**
 * Loading a song onto a deck and ejecting it: open the song's audio, wait until the first seconds can be played,
 * then fill in what comes after (waveform overview, beat grid, saved cues) while the deck is already usable.
 */
import { deckGridOf } from '@core/dj/decks-math';
import type { SampleRef } from '@core/model/types';
import type { DeckSource } from '@engine/deck/deck-source';
import { DeckStream } from '@engine/deck/deck-stream';
import { DECK_IDS, HOT_CUES, type DeckId, type DeckState } from '../decks-api';
import type { BackgroundAnalysis } from './background-analysis';
import type { DeckContext } from './context';
import type { GraphLifecycle } from './graph-lifecycle';
import { blankDeck, unsetHotCues } from './state';
import { announceStream, type Streams } from './streams';
import type { Tempo } from './tempo';
import type { Transport } from './transport';
import { fillOverview } from './waveform-overview';

/** A file that can't be read (removed from the store, damaged) would wait forever: it gets this long (ms), then fails. */
const UNREADABLE_AFTER_MS = 20_000;

/** The deck is announced as loaded once this many seconds of the song are in its window. */
const FIRST_SECONDS_READY = 2;

/** The loading and ejecting of one set of decks. */
export interface Loader {
  /** Loads a library song (or any audio sample) on a deck; analysis is fetched or computed. */
  load(deckId: DeckId, ref: SampleRef, title: string, artist?: string): Promise<void>;
  eject(deckId: DeckId): void;
}

/** Makes the loader of a set of decks. */
export function createLoader(
  context: DeckContext,
  parts: {
    graphLifecycle: GraphLifecycle;
    streams: Streams;
    tempo: Tempo;
    transport: Transport;
    backgroundAnalysis: BackgroundAnalysis;
  },
): Loader {
  const { deps, runtime, deckState, patchDeck, channelOf } = context;
  const { graphLifecycle, streams, tempo, transport, backgroundAnalysis } = parts;

  /** Takes every deck that follows this one out of sync (the song its tempo came from is going away). */
  function releaseFollowers(masterId: DeckId): void {
    for (const deckId of DECK_IDS) if (runtime[deckId].syncMaster === masterId) tempo.unsync(deckId);
  }

  /** Drops everything the deck knew about its song (the audio window, the analysis, any background work). */
  function forgetSong(deckId: DeckId): void {
    const deckRuntime = runtime[deckId];
    deckRuntime.analysis = null;
    deckRuntime.grid = null;
    deckRuntime.waveform = null;
    deckRuntime.stream?.dispose();
    deckRuntime.stream = null;
    deckRuntime.songHash = null;
    deckRuntime.syncMaster = null;
    deckRuntime.backgroundAnalysis?.abort();
    deckRuntime.backgroundAnalysis = null;
  }

  /** Waits until the first seconds are in the window; a file that can't be read fails after `UNREADABLE_AFTER_MS`. */
  async function waitForFirstSeconds(stream: DeckStream, title: string, isStale: () => boolean): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unreadable = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Couldn’t read “${title}”: its file can’t be read.`)), UNREADABLE_AFTER_MS);
    });
    try {
      await Promise.race([stream.whenResident(0, Math.round(FIRST_SECONDS_READY * stream.sampleRate)), unreadable]);
    } catch (error) {
      if (!isStale()) throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The cue point and hot cues a song starts with: the ones saved for it, else the first downbeat and no hot cues. */
  async function startingCues(deckId: DeckId, isStale: () => boolean): Promise<{ cuePoint: number; hotCues: (number | null)[] } | null> {
    const { grid, songHash } = runtime[deckId];
    const saved = songHash && deps.cues ? await deps.cues.load(songHash).catch(() => null) : null;
    if (isStale()) return null;
    if (saved) {
      return { cuePoint: saved.cuePoint, hotCues: Array.from({ length: HOT_CUES }, (_, i) => saved.hotCues[i] ?? null) };
    }
    return { cuePoint: grid ? Math.max(0, grid.firstDownbeat) : 0, hotCues: unsetHotCues() };
  }

  /**
   * The part of loading that happens while the song can already be played: the analysis (now for a song decoded
   * whole; for a song read by parts it comes in the background unless it is known already), the saved cues, and
   * parking the deck on the first beat.
   */
  async function finishLoading(
    deckId: DeckId,
    ref: SampleRef,
    title: string,
    buffer: AudioBuffer | null,
    isStale: () => boolean,
  ): Promise<void> {
    const deckRuntime = runtime[deckId];
    const analysis = deps.peekAnalysis(ref) ?? (buffer ? await deps.analysis(ref, { priority: 'now' }).catch(() => null) : null);
    if (isStale()) return;
    deckRuntime.analysis = analysis;
    deckRuntime.grid = analysis?.grid ? deckGridOf(analysis.grid) : null;
    deckRuntime.songHash = analysis?.hash ?? (ref.source.kind === 'embedded' ? ref.source.hash : null);
    const baseBpm = deckRuntime.grid?.bpm ?? null;
    const cues = await startingCues(deckId, isStale);
    if (!cues) return;
    patchDeck(deckId, { loading: false, baseBpm, bpm: baseBpm, cuePoint: cues.cuePoint, hotCues: cues.hotCues });
    streams.refreshPins(deckId);
    // Park at the first beat so the first press of play starts on the one.
    transport.seek(deckId, cues.cuePoint);
    const needsBackgroundAnalysis = !analysis && !buffer && ref.source.kind === 'embedded';
    if (needsBackgroundAnalysis) backgroundAnalysis.start(deckId, ref, title, isStale);
  }

  /**
   * The waveform overview arrives while the song can already be played. A song decoded whole is filled before going on
   * (false if the deck moved on meanwhile); a song read by parts is read through in the background (an hour takes a while).
   */
  async function startOverview(deckId: DeckId, source: DeckSource, buffer: AudioBuffer | null, isStale: () => boolean): Promise<boolean> {
    if (buffer) return fillOverview(context, deckId, source, buffer, isStale);
    void fillOverview(context, deckId, source, null, isStale);
    return true;
  }

  async function load(deckId: DeckId, ref: SampleRef, title: string, artist?: string): Promise<void> {
    const deckRuntime = runtime[deckId];
    const loadToken = ++deckRuntime.loadToken;
    releaseFollowers(deckId);
    transport.stopDeck(deckId);
    forgetSong(deckId);
    const songInfo = { ref, title, ...(artist ? { artist } : {}) };
    patchDeckToBlank(deckId, { loading: true, song: { ...songInfo, durationSec: ref.durationSec ?? 0 } });
    const isStale = () => loadToken !== deckRuntime.loadToken || context.isDisposed;
    let isAudioReady = false;
    try {
      void deps.resume().catch(() => {});
      const graph = await graphLifecycle.ensureGraph();
      if (isStale()) return;
      // The old song's window goes before the new one is made: a deck never holds two.
      channelOf(deckId)?.send({ t: 'eject' });
      const { source, buffer } = await streams.openSource(ref, title, graph);
      if (isStale()) return void source.dispose();
      const stream = new DeckStream(source);
      deckRuntime.stream = stream;
      // The first seconds are in the window before the song is announced (a source in memory needs no wait at all).
      stream.moveTo(0);
      await waitForFirstSeconds(stream, title, isStale);
      if (isStale()) return;
      isAudioReady = true;
      patchDeck(deckId, { song: { ...songInfo, durationSec: source.nativeFrames / source.nativeRate } });
      const channel = channelOf(deckId);
      if (channel) announceStream(channel, stream);
      channel?.send({ t: 'tempo', rate: 1, keyLock: deckState(deckId).keyLock });
      if (!(await startOverview(deckId, source, buffer, isStale))) return;
      await finishLoading(deckId, ref, title, buffer, isStale);
    } catch (error) {
      if (isStale()) return;
      if (isAudioReady) {
        patchDeck(deckId, { loading: false });
        deps.toast(error instanceof Error ? error.message : String(error), 'error');
        return;
      }
      channelOf(deckId)?.send({ t: 'eject' });
      deckRuntime.stream?.dispose();
      deckRuntime.stream = null;
      patchDeckToBlank(deckId);
      throw error;
    }
  }

  /** Puts the deck back to nothing loaded (mixer settings stay), with `extra` on top. */
  function patchDeckToBlank(deckId: DeckId, extra: Partial<DeckState> = {}): void {
    patchDeck(deckId, blankDeck(deckState(deckId), extra));
  }

  function eject(deckId: DeckId): void {
    runtime[deckId].loadToken++;
    releaseFollowers(deckId);
    transport.stopDeck(deckId);
    channelOf(deckId)?.send({ t: 'eject' });
    forgetSong(deckId);
    patchDeckToBlank(deckId);
  }

  return { load, eject };
}
