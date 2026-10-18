/**
 * The decks' audio graph: made when the first song is loaded, moved over to a new one when the engine reboots (the
 * decks keep their songs, positions and settings), and the headphone (cue) output device.
 */
import { DeckGraph } from '@engine/deck/deck-graph';
import { DECK_IDS, type DeckId } from '../decks-api';
import { deckIndex, type DeckContext } from './context';
import type { Streams } from './streams';
import type { Tempo } from './tempo';
import type { Ticker } from './ticker';
import type { Transport } from './transport';

/** Where the chosen cue output device is kept between sessions. */
const CUE_DEVICE_STORAGE_KEY = 'agstudio.dj.cueDevice';

/** The graph and cue device controls of one set of decks. */
export interface GraphLifecycle {
  /** The audio graph, made now if there is none (or the engine has a new context). Rejects where there is no engine. */
  ensureGraph(): Promise<DeckGraph>;
  /** Plays the cue (headphone) bus through this output device ('' = none); false where the browser can't. */
  setCueDevice(deviceId: string): Promise<boolean>;
  /** Stops following the engine's reboots (first step of closing the decks). */
  stopWatchingHost(): void;
  /** Frees the graph (after the decks have stopped their players). */
  disposeGraph(): void;
}

/** Makes the graph lifecycle of a set of decks (it starts watching the engine at once). */
export function createGraphLifecycle(
  context: DeckContext,
  parts: { streams: Streams; tempo: Tempo; ticker: Ticker; transport: Transport },
): GraphLifecycle {
  const { deps, runtime, deckState, patchDeck, now } = context;
  const { streams, tempo, ticker, transport } = parts;
  let pendingGraph: Promise<DeckGraph> | null = null;
  let cueDeviceId = readSavedCueDevice();

  function ensureGraph(): Promise<DeckGraph> {
    if (context.graph && deps.host()?.ctx === context.graph.ctx) return Promise.resolve(context.graph);
    if (pendingGraph) return pendingGraph;
    const host = deps.host();
    if (!host) return Promise.reject(new Error('The audio engine isn’t running here, so the decks can’t play.'));
    const making = (async () => {
      const graph = await DeckGraph.create(host);
      if (context.isDisposed) {
        graph.dispose();
        throw new Error('The decks were closed.');
      }
      const oldGraph = context.graph;
      context.graph = graph;
      attachAll(graph, oldGraph);
      oldGraph?.dispose();
      if (cueDeviceId) void graph.setCueOutput(cueDeviceId);
      return graph;
    })().finally(() => {
      if (pendingGraph === making) pendingGraph = null;
    });
    pendingGraph = making;
    return making;
  }

  // The engine rebooted (a new context): the decks move over with their songs, positions and settings.
  const stopWatchingHost = deps.subscribeHost(() => {
    if (context.isDisposed || !context.graph) return;
    const host = deps.host();
    if (host && host.ctx !== context.graph.ctx) void ensureGraph().catch(() => {});
  });

  /** Pushes everything a graph needs to sound like the state says (a new graph, after a reboot). */
  function attachAll(graph: DeckGraph, oldGraph: DeckGraph | null): void {
    const state = context.store.getState();
    graph.setMasterVolume(state.masterVolume);
    for (const deckId of DECK_IDS) {
      const deck = state.decks[deckId];
      const channel = graph.channel(deckIndex(deckId));
      channel.onEnded = () => transport.ended(deckId);
      channel.setTrim(deck.trimDb);
      channel.setEq('low', deck.eq.low);
      channel.setEq('mid', deck.eq.mid);
      channel.setEq('high', deck.eq.high);
      channel.setFilter(deck.filter);
      channel.setFader(deck.volume);
      channel.setCueListen(deck.cueListen);
      channel.setCrossfade(state.crossfaderAssign[deckId], state.crossfader, state.crossfaderCurve);
      moveSongToGraph(deckId, graph, oldGraph);
    }
    // Followers need the new masters' state blocks.
    for (const deckId of DECK_IDS) if (runtime[deckId].syncMaster) tempo.sendSync(deckId);
    ticker.start();
  }

  /** Hands a deck's song to the new graph, where it was, or reads it again when the new context has another sample rate. */
  function moveSongToGraph(deckId: DeckId, graph: DeckGraph, oldGraph: DeckGraph | null): void {
    const deck = deckState(deckId);
    const stream = runtime[deckId].stream;
    if (!deck.song || !stream) return;
    const oldFrame = oldGraph?.channel(deckIndex(deckId)).snapshot().pos;
    if (stream.sampleRate !== graph.ctx.sampleRate) {
      // The new context runs at another rate: read the song again for it.
      const positionSec = oldFrame === undefined ? deck.positionSec : oldFrame / stream.sampleRate;
      patchDeck(deckId, { positionSec, positionAt: now() });
      void streams.reloadFor(deckId, graph);
      return;
    }
    streams.sendStream(deckId, stream, oldFrame ?? deck.positionSec * graph.ctx.sampleRate);
  }

  async function setCueDevice(deviceId: string): Promise<boolean> {
    cueDeviceId = deviceId;
    saveCueDevice(deviceId);
    const graph = context.graph ?? (DECK_IDS.some(context.isLoaded) ? await ensureGraph().catch(() => null) : null);
    return graph ? graph.setCueOutput(deviceId) : true;
  }

  function disposeGraph(): void {
    context.graph?.dispose();
    context.graph = null;
  }

  return { ensureGraph, setCueDevice, stopWatchingHost, disposeGraph };
}

function readSavedCueDevice(): string {
  try {
    return globalThis.localStorage?.getItem(CUE_DEVICE_STORAGE_KEY) ?? '';
  } catch {
    return ''; // storage unavailable
  }
}

function saveCueDevice(deviceId: string): void {
  try {
    globalThis.localStorage?.setItem(CUE_DEVICE_STORAGE_KEY, deviceId);
  } catch {
    /* storage unavailable */
  }
}
