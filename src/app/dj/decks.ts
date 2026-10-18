/**
 * DJ live decks: the `DecksApi` implementation. Four decks, a mixer and a master, played through the engine's
 * output. This is the control side (what a button, a MIDI controller or the Studio asks for, kept as state in the
 * store); the sound is made by the players on the audio thread (`engine/deck/deck.kernel.ts`), which this talks
 * to through messages and reads back through shared memory. See docs/architecture.md, "DJ live decks".
 *
 * Deck state is live performance state: it is not in the project and not in History. The decks are created on first
 * use (`decks-factory.ts`) and their audio graph on the first song loaded.
 *
 * Positions are seconds of the song file everywhere in the API; the players count frames of the context's rate (the
 * song is decoded at it), so a frame is a second × `sampleRate`.
 *
 * The work is split by job into `deck-control/`: each module is built from the shared `DeckContext` and this file
 * only wires them together.
 */
import { DECK_IDS, type DecksApi } from './decks-api';
import { createBackgroundAnalysis } from './deck-control/background-analysis';
import { createDeckContext, type DecksDeps } from './deck-control/context';
import { createCues } from './deck-control/cues';
import { createGraphLifecycle } from './deck-control/graph-lifecycle';
import { createJog } from './deck-control/jog';
import { createLoader } from './deck-control/loader';
import { createLoops } from './deck-control/loops';
import { createMixer } from './deck-control/mixer';
import { createPositions } from './deck-control/positions';
import { createRecorder } from './deck-control/recorder';
import { initialDecksState } from './deck-control/state';
import { createStreams } from './deck-control/streams';
import { createTempo } from './deck-control/tempo';
import { createTicker } from './deck-control/ticker';
import { createTransport } from './deck-control/transport';

export { initialDecksState };
export type { DecksDeps, SavedCues } from './deck-control/context';

/** After a jump, how far before the play position (seconds) the window must be filled for `settled` to resolve. */
const SETTLED_BEHIND_SEC = 0.5;
/** ... and how far ahead (seconds). */
const SETTLED_AHEAD_SEC = 4;

/** Makes a set of four decks. */
export function createDecks(deps: DecksDeps): DecksApi {
  const context = createDeckContext(deps);
  const { store, runtime, deckState } = context;

  const positions = createPositions(context);
  const streams = createStreams(context);
  const ticker = createTicker(context, positions);
  const tempo = createTempo(context);
  const transport = createTransport(context, positions, ticker);
  const cues = createCues(context, positions, streams, transport);
  const jog = createJog(context, positions, transport);
  const loops = createLoops(context, positions, streams, transport);
  const mixer = createMixer(context, tempo);
  const graphLifecycle = createGraphLifecycle(context, { streams, tempo, ticker, transport });
  const backgroundAnalysis = createBackgroundAnalysis(context, streams, transport);
  const loader = createLoader(context, { graphLifecycle, streams, tempo, transport, backgroundAnalysis });
  const recorder = createRecorder(context, graphLifecycle.ensureGraph);

  function dispose(): void {
    if (context.isDisposed) return;
    context.isDisposed = true;
    graphLifecycle.stopWatchingHost();
    mixer.cancelFade();
    ticker.stop();
    recorder.cancel();
    for (const deckId of DECK_IDS) {
      transport.stopDeck(deckId);
      runtime[deckId].loadToken++;
      runtime[deckId].stream?.dispose();
      runtime[deckId].stream = null;
    }
    graphLifecycle.disposeGraph();
    store.setState(initialDecksState());
  }

  /** Every deck's window has what is about to be heard (a source read from a file takes a moment after a jump), then the players have handled everything sent. */
  async function settled(): Promise<void> {
    for (const deckId of DECK_IDS) {
      const stream = runtime[deckId].stream;
      if (!stream || !deckState(deckId).song) continue;
      const playFrame = Math.round(deckState(deckId).positionSec * stream.sampleRate);
      const from = playFrame - Math.round(SETTLED_BEHIND_SEC * stream.sampleRate);
      const to = playFrame + SETTLED_AHEAD_SEC * stream.sampleRate;
      await stream.whenResident(from, to).catch(() => {});
    }
    await context.graph?.settled();
  }

  return {
    store,
    load: loader.load,
    eject: loader.eject,
    play: transport.play,
    pause: transport.pause,
    togglePlay: transport.togglePlay,
    cueDown: cues.cueDown,
    cueUp: cues.cueUp,
    seek: transport.seek,
    jog: jog.jog,
    jogTouch: jog.jogTouch,
    setPitch: tempo.setPitch,
    setPitchRange: tempo.setPitchRange,
    setKeyLock: tempo.setKeyLock,
    sync: tempo.sync,
    setVolume: mixer.setVolume,
    setTrim: mixer.setTrim,
    setEq: mixer.setEq,
    setFilter: mixer.setFilter,
    setCueListen: mixer.setCueListen,
    setCrossfader: mixer.setCrossfader,
    setCrossfaderAssign: mixer.setCrossfaderAssign,
    setMasterVolume: mixer.setMasterVolume,
    hotCue: cues.hotCue,
    clearHotCue: cues.clearHotCue,
    loopIn: loops.loopIn,
    loopOut: loops.loopOut,
    autoLoop: loops.autoLoop,
    loopHalve: loops.loopHalve,
    loopDouble: loops.loopDouble,
    exitLoop: loops.exitLoop,
    beatJumpBy: loops.beatJumpBy,
    startRecording: recorder.startRecording,
    stopRecording: recorder.stopRecording,
    positionNow: positions.positionNow,
    dispose,
    setCrossfaderCurve: mixer.setCrossfaderCurve,
    setDeckCount: (count) => store.setState({ deckCount: count }),
    setBeatJump: loops.setBeatJump,
    crossfade: mixer.crossfade,
    readLevels(out) {
      if (context.graph) context.graph.readLevels(out);
      else out.fill(0);
    },
    waveformOf: (deckId) => runtime[deckId].waveform,
    analysisOf: (deckId) => runtime[deckId].analysis,
    setCueDevice: graphLifecycle.setCueDevice,
    keepUp: ticker.keepUp,
    isStalled: positions.isStalled,
    settled,
  };
}
