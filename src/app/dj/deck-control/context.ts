/**
 * What the pieces of the decks share: the dependencies the app gave them, the state store, the per-deck bookkeeping
 * the store doesn't hold, and the one audio graph. Each module in this folder is built from a `DeckContext` and does
 * one job (transport, loops, sync, ...); `../decks.ts` puts them together into the `DecksApi`.
 */
import type { StoreApi } from 'zustand/vanilla';
import { createStore } from 'zustand/vanilla';
import type { DeckGrid } from '@core/dj/decks-math';
import type { DeckWaveform } from '@core/dj/deck-peaks';
import type { TrackAnalysis } from '@core/dj/types';
import type { SampleRef } from '@core/model/types';
import type { DeckHost } from '@engine/api';
import type { DeckChannel, DeckGraph } from '@engine/deck/deck-graph';
import type { DeckStream } from '@engine/deck/deck-stream';
import type { SampleCache } from '@engine/samples';
import { DECK_IDS, type DeckId, type DeckState, type DecksState } from '../decks-api';
import { initialDecksState } from './state';

/** What the decks need from the app (the factory wires them to the services; tests pass their own). */
export interface DecksDeps {
  /** The live-audio host of the running engine, or null when there is none (offline, tests). */
  host(): DeckHost | null;
  /** Calls back when the engine may have changed (a reboot gives a new context). */
  subscribeHost(fn: () => void): () => void;
  /** Resumes the audio context (browsers start it suspended until a click). */
  resume(): Promise<void>;
  cache: SampleCache;
  /**
   * The song's analysis: cached, or computed now. Null when it can't be analyzed. `signal` stops the work (when nothing else
   * wants it); a deck passes priority 'now', so it goes ahead of the library's queued songs.
   */
  analysis(
    ref: SampleRef,
    opts?: { signal?: AbortSignal; onProgress?(fraction: number): void; priority?: 'now' | 'background' },
  ): Promise<TrackAnalysis | null>;
  /** The song's analysis if it is already known, without computing it. */
  peekAnalysis(ref: SampleRef): TrackAnalysis | null;
  /** Puts a recording in the music library; resolves with its title. */
  addRecording(file: File, title: string): Promise<string | null>;
  toast(message: string, kind?: 'error'): void;
  /**
   * The song's file, read lazily a part at a time (an OPFS file), or null: what a song too long to decode whole is
   * played from. Without it every song is decoded whole through the cache.
   */
  openFile?(ref: SampleRef): Promise<Blob | null>;
  /** Cue points and hot cues kept per song (by content hash). */
  cues?: {
    load(hash: string): Promise<SavedCues | null>;
    save(hash: string, cues: SavedCues): void;
  };
  /** performance.now() (tests may drive time). */
  now?(): number;
}

/** A song's cue point and hot cues as kept between sessions (seconds of the song file; null = hot cue not set). */
export interface SavedCues {
  cuePoint: number;
  hotCues: (number | null)[];
}

/** The tempo a follower deck matches its master at, as a multiple of the follower's own tempo (half, same, double time). */
export type SyncMultiple = 0.5 | 1 | 2;

/** What the decks keep per deck besides its state in the store. */
export interface DeckRuntime {
  analysis: TrackAnalysis | null;
  grid: DeckGrid | null;
  waveform: DeckWaveform | null;
  /** The song's audio as a window of blocks the player reads (its source is decoded or read from the file as it goes). */
  stream: DeckStream | null;
  /** Counts loads: an older load that finishes late is dropped. */
  loadToken: number;
  /** The cue button is held and the deck plays from the cue point until it is let go. */
  isPreviewingCue: boolean;
  /** The deck follows this one, matching its tempo as `syncMultiple` times its own. */
  syncMaster: DeckId | null;
  syncMultiple: SyncMultiple;
  /** The platter is held (or a scratch drag is going), so the player is in scratch mode. */
  isTouching: boolean;
  /** The last seek (clock ms, and where to in seconds): until the player has handled it, its published position is the old one. */
  lastSeekAtMs: number;
  lastSeekToSec: number;
  /** When the jog wheel last moved (clock ms), to tell how fast it is turning. */
  lastJogAtMs: number;
  /** Lets a scratch go when the platter stops moving without being told. */
  scratchTimer: ReturnType<typeof setTimeout> | null;
  /** Content hash of the song, the key its cues are saved under. */
  songHash: string | null;
  /** The analysis being made in the background for a song read by parts (stopped when the deck lets go of the song). */
  backgroundAnalysis: AbortController | null;
}

function emptyRuntime(): DeckRuntime {
  return {
    analysis: null,
    grid: null,
    waveform: null,
    stream: null,
    loadToken: 0,
    isPreviewingCue: false,
    syncMaster: null,
    syncMultiple: 1,
    isTouching: false,
    lastSeekAtMs: 0,
    lastSeekToSec: 0,
    lastJogAtMs: 0,
    scratchTimer: null,
    songHash: null,
    backgroundAnalysis: null,
  };
}

/** Used when no audio graph exists yet to ask (frames per second of the context the decks will make). */
const FALLBACK_SAMPLE_RATE = 48000;

/** The deck's slot (0 to 3) in the audio graph. */
export const deckIndex = (deckId: DeckId): number => DECK_IDS.indexOf(deckId);

/** The shared state of one set of decks, and the small readers and writers every module uses. */
export interface DeckContext {
  readonly deps: DecksDeps;
  readonly store: StoreApi<DecksState>;
  readonly runtime: Record<DeckId, DeckRuntime>;
  /** Decks whose platter is being held (a held platter doesn't let go by timeout). */
  readonly heldPlatters: Set<DeckId>;
  /** The audio graph, once the first song asked for it; replaced when the engine reboots. */
  graph: DeckGraph | null;
  /** True after `dispose`: late async results are dropped. */
  isDisposed: boolean;
  /** The clock in ms (`performance.now()` unless a test drives time). */
  now(): number;
  deckState(deckId: DeckId): DeckState;
  patchDeck(deckId: DeckId, patch: Partial<DeckState>): void;
  /** The deck's player channel in the graph, or null before there is a graph. */
  channelOf(deckId: DeckId): DeckChannel | null;
  /** Frames per second of the audio context (songs are decoded at it). */
  sampleRate(): number;
  isLoaded(deckId: DeckId): boolean;
  durationOf(deckId: DeckId): number;
}

/** Makes the shared state for a set of decks, with nothing loaded. */
export function createDeckContext(deps: DecksDeps): DeckContext {
  const store = createStore<DecksState>(() => initialDecksState());
  const context: DeckContext = {
    deps,
    store,
    runtime: { A: emptyRuntime(), B: emptyRuntime(), C: emptyRuntime(), D: emptyRuntime() },
    heldPlatters: new Set<DeckId>(),
    graph: null,
    isDisposed: false,
    now: deps.now ?? (() => performance.now()),
    deckState: (deckId) => store.getState().decks[deckId],
    patchDeck: (deckId, patch) =>
      store.setState((state) => ({ decks: { ...state.decks, [deckId]: { ...state.decks[deckId], ...patch } } })),
    channelOf: (deckId) => context.graph?.channel(deckIndex(deckId)) ?? null,
    sampleRate: () => context.graph?.ctx.sampleRate ?? FALLBACK_SAMPLE_RATE,
    isLoaded: (deckId) => context.deckState(deckId).song !== null,
    durationOf: (deckId) => context.deckState(deckId).song?.durationSec ?? 0,
  };
  return context;
}
