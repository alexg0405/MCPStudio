/**
 * Recording the master output: the sound is captured as 16-bit WAV while it plays, and on stop the file goes into
 * the music library (the Studio can then turn it into an audio clip).
 */
import { liveMixTitle } from '@core/dj/decks-math';
import { WavStreamEncoder } from '@core/io/wav';
import type { TapCapture } from '@engine/deck/tap-capture';
import type { DeckGraph } from '@engine/deck/deck-graph';
import type { DeckContext } from './context';

/** How much audio after the stop press is still captured (seconds), so the last note's tail isn't cut off. */
const STOP_TAIL_SEC = 0.05;

/** A recording in progress: the capture tap, and the WAV pieces written so far. */
interface Capture {
  tap: TapCapture;
  wavPieces: Uint8Array[];
  encoder: WavStreamEncoder;
}

/** Recording of one set of decks. */
export interface Recorder {
  startRecording(): Promise<void>;
  /** Stops and puts the recording in the library; resolves with its title (null if nothing was recorded). */
  stopRecording(): Promise<string | null>;
  /** Throws a recording in progress away (closing the decks). */
  cancel(): void;
}

/** Makes the recorder of a set of decks; `ensureGraph` brings up the audio graph when recording starts. */
export function createRecorder(context: DeckContext, ensureGraph: () => Promise<DeckGraph>): Recorder {
  const { deps, store, now } = context;
  let capture: Capture | null = null;

  async function startRecording(): Promise<void> {
    if (capture || store.getState().recording) return;
    const graph = await ensureGraph();
    await deps.resume().catch(() => {});
    const wavPieces: Uint8Array[] = [];
    const encoder = new WavStreamEncoder(2, graph.ctx.sampleRate, { bitDepth: 16, dither: true, seed: 1 });
    const tap = await graph.openCapture((channels) => {
      wavPieces.push(encoder.push(channels));
    });
    capture = { tap, wavPieces, encoder };
    store.setState({ recording: { startedAt: now() } });
  }

  async function stopRecording(): Promise<string | null> {
    const finished = capture;
    if (!finished) return null;
    capture = null;
    store.setState({ recording: null });
    const info = await finished.tap.stop(STOP_TAIL_SEC);
    if (info.frames === 0) return null;
    const header = finished.encoder.header(info.frames);
    const trailer = finished.encoder.trailer();
    const title = liveMixTitle(new Date());
    const parts = [header, ...finished.wavPieces, trailer] as BlobPart[];
    const file = new File(parts, `${title}.wav`, { type: 'audio/wav' });
    return deps.addRecording(file, title);
  }

  function cancel(): void {
    capture?.tap.cancel();
    capture = null;
  }

  return { startRecording, stopRecording, cancel };
}
