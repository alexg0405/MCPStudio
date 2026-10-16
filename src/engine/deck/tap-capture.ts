/**
 * Records any audio node (stereo) for as long as asked, through the streaming input recorder's worklet
 * (`input-recorder.worklet.ts`): it writes into a 30 s SharedArrayBuffer ring and this side drains it every 50 ms
 * and hands the audio on in chunks, so a take is limited only by what the caller does with them (the decks encode
 * them to 16-bit WAV as they come). The worklet puts every block at its own clock position, so the recording is as
 * long as the time that passed.
 */
import inputRecorderUrl from '../input-recorder.worklet.ts?worker&url';
import { IN_MODE, IN_STATE, INPUT_RECORDER_ID, LEVEL_BLOCKS } from '../input-recorder-id';

const RING_SECONDS = 30;
const DRAIN_MS = 50;

export interface TapCapture {
  readonly sampleRate: number;
  /** Frames handed over so far. */
  readonly frames: number;
  /** Ends the capture after `tail` more seconds; resolves with the totals once the last chunk was delivered. */
  stop(tail?: number): Promise<{ frames: number; sampleRate: number; dropped: number }>;
  cancel(): void;
}

export async function openTapCapture(
  ctx: AudioContext,
  loadModule: (url: string) => Promise<void>,
  source: AudioNode,
  onChunk: (channels: [Float32Array, Float32Array]) => void,
): Promise<TapCapture> {
  if (typeof SharedArrayBuffer === 'undefined' || !(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated)
    throw new Error('Recording needs cross-origin isolation: run AGstudio from its own dev or preview server.');
  await loadModule(inputRecorderUrl);
  const ch = 2;
  const sr = ctx.sampleRate;
  const capacity = Math.round(RING_SECONDS * sr);
  const data = new SharedArrayBuffer(capacity * ch * 4);
  const stateBuf = new SharedArrayBuffer(4 * 4);
  const startBuf = new SharedArrayBuffer(8);
  const levelBuf = new SharedArrayBuffer(LEVEL_BLOCKS * 2 * 4);
  const ring = new Float32Array(data);
  const state = new Int32Array(stateBuf);
  const node = new AudioWorkletNode(ctx, INPUT_RECORDER_ID, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: ch,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { data, state: stateBuf, start: startBuf, levels: levelBuf, channels: ch },
  });
  // A silent path to the destination keeps the recorder running.
  const sink = new GainNode(ctx, { gain: 0 });
  source.connect(node);
  node.connect(sink).connect(ctx.destination);

  let read = 0;
  let dropped = 0;
  let done = false;
  Atomics.store(state, IN_STATE.written, -1);
  Atomics.store(state, IN_STATE.mode, IN_MODE.recording);

  const drain = () => {
    const written = Atomics.load(state, IN_STATE.written);
    if (written <= read) return;
    let from = read;
    let lost = 0;
    if (written - read > capacity) {
      // The main thread stalled longer than the ring: those frames are lost; keep time with silence.
      lost = written - read - capacity;
      dropped += lost;
      from = written - capacity;
    }
    const n = written - from;
    if (lost > 0) onChunk([new Float32Array(lost), new Float32Array(lost)]);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = ((from + i) % capacity) * ch;
      l[i] = ring[o] as number;
      r[i] = ring[o + 1] as number;
    }
    onChunk([l, r]);
    read = written;
  };
  const timer = setInterval(drain, DRAIN_MS);

  const release = () => {
    done = true;
    clearInterval(timer);
    Atomics.store(state, IN_STATE.mode, IN_MODE.closed);
    try {
      source.disconnect(node);
    } catch {
      /* already disconnected */
    }
    node.disconnect();
    sink.disconnect();
  };

  return {
    sampleRate: sr,
    get frames() {
      return read;
    },
    stop(tail = 0) {
      if (done) return Promise.reject(new Error('The capture has already ended.'));
      return new Promise((resolve) =>
        setTimeout(
          () => {
            clearInterval(timer);
            drain();
            const total = read;
            release();
            resolve({ frames: total, sampleRate: sr, dropped });
          },
          Math.max(0, tail * 1000),
        ),
      );
    },
    cancel() {
      if (!done) release();
    },
  };
}
