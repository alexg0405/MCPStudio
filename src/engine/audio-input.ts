/**
 * A live audio input (microphone, audio interface) on the engine's clock: a level meter, optional
 * monitoring through a mixer track, and streaming captures of any length. The worklet
 * (input-recorder.worklet.ts) writes into a 30 s SharedArrayBuffer ring; this side drains it every
 * 50 ms into chunks, so a take is limited only by memory.
 */
import type { InsertId } from '@core/model/types';
import inputRecorderUrl from './input-recorder.worklet.ts?worker&url';
import { IN_MODE, IN_STATE, INPUT_RECORDER_ID, LEVEL_BLOCKS } from './input-recorder-id';

/** Seconds of audio the ring holds between drains (the main thread may stall that long). */
const RING_SECONDS = 30;
const DRAIN_MS = 50;
/** Frames per [min, max] pair of the live peak overview. */
export const CAPTURE_BUCKET = 256;

export interface CapturedAudio {
  /** One array per channel, from the first captured frame. */
  channels: Float32Array[];
  sampleRate: number;
  /** AudioContext time of the first frame. */
  startTime: number;
  /** Frames lost because the main thread didn't drain the ring in time (filled with silence). */
  dropped: number;
}

export interface AudioCapture {
  readonly sampleRate: number;
  readonly channelCount: number;
  /** AudioContext time of the first captured frame (NaN until it arrives). */
  readonly startTime: number;
  /** Frames captured so far. */
  readonly frames: number;
  /** Live peak overview: interleaved [min, max] per `bucket` frames, `buckets` of them filled. */
  readonly peaks: Float32Array;
  readonly buckets: number;
  readonly bucket: number;
  /** Ends the capture after `tail` more seconds (audio still on its way through the input). */
  stop(tail?: number): Promise<CapturedAudio>;
  /** Drops it. */
  cancel(): void;
}

export interface AudioInput {
  readonly channelCount: 1 | 2;
  readonly label: string;
  /**
   * Seconds from scheduling a sound to recording it back when you play along (output latency,
   * the master limiter's look-ahead and the input's own latency), as the browser reports them.
   */
  readonly estimatedLatency: number;
  readonly closed: boolean;
  /** Peak of each channel over the last ~85 ms (0–1) into out[0] and out[1]. */
  levels(out: Float32Array): void;
  /** Plays the input through a mixer track (null: monitoring off). */
  setMonitor(track: InsertId | null, gain?: number): void;
  /** Starts a capture (one at a time) at the next render quantum. */
  startCapture(): AudioCapture;
  close(): void;
}

export interface AudioInputDeps {
  loadModule(url: string): Promise<void>;
  insertInput(id: InsertId): AudioNode;
  /** Output side of the round trip (seconds): output latency and the limiter. */
  outputLatency(): number;
}

export function canCapture(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  );
}

export async function openAudioInput(
  ctx: AudioContext,
  deps: AudioInputDeps,
  stream: MediaStream,
  opts: { channels: 1 | 2; label?: string; latency?: number },
): Promise<AudioInput> {
  if (!canCapture())
    throw new Error('Recording needs cross-origin isolation: run AGstudio from its own dev or preview server.');
  await deps.loadModule(inputRecorderUrl);
  const ch = opts.channels;
  const sr = ctx.sampleRate;
  const capacity = Math.round(RING_SECONDS * sr);
  const data = new SharedArrayBuffer(capacity * ch * 4);
  const stateBuf = new SharedArrayBuffer(4 * 4);
  const startBuf = new SharedArrayBuffer(8);
  const levelBuf = new SharedArrayBuffer(LEVEL_BLOCKS * 2 * 4);
  const ring = new Float32Array(data);
  const state = new Int32Array(stateBuf);
  const start = new Float64Array(startBuf);
  const levelRing = new Float32Array(levelBuf);

  const source = new MediaStreamAudioSourceNode(ctx, { mediaStream: stream });
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
  source.connect(node).connect(sink).connect(ctx.destination);
  const monitor = new GainNode(ctx, { gain: 1 });
  let monitorTo: AudioNode | null = null;
  let capture: (AudioCapture & { drain(): void }) | null = null;
  let closed = false;

  const setMonitor = (track: InsertId | null, gain = 1) => {
    if (closed) return;
    if (monitorTo) {
      source.disconnect(monitor);
      monitor.disconnect();
      monitorTo = null;
    }
    if (track === null) return;
    monitor.gain.value = gain;
    monitorTo = deps.insertInput(track);
    source.connect(monitor).connect(monitorTo);
  };

  const startCapture = (): AudioCapture => {
    if (closed) throw new Error('The audio input is closed.');
    capture?.cancel();
    const chunks: Float32Array[][] = Array.from({ length: ch }, () => []);
    let read = 0;
    let dropped = 0;
    let peaks = new Float32Array(1024);
    let buckets = 0;
    let bucketFill = 0;
    let lo = 0;
    let hi = 0;
    let done = false;
    Atomics.store(state, IN_STATE.written, -1);
    Atomics.store(state, IN_STATE.mode, IN_MODE.recording);

    const pushPeak = () => {
      if (buckets * 2 + 2 > peaks.length) {
        const grown = new Float32Array(peaks.length * 2);
        grown.set(peaks);
        peaks = grown;
      }
      peaks[buckets * 2] = lo;
      peaks[buckets * 2 + 1] = hi;
      buckets++;
      bucketFill = 0;
      lo = 0;
      hi = 0;
    };

    const drain = () => {
      const written = Atomics.load(state, IN_STATE.written);
      if (written <= read) return;
      let from = read;
      if (written - read > capacity) {
        // The main thread stalled longer than the ring: those frames are lost; keep time with silence.
        const lost = written - read - capacity;
        dropped += lost;
        for (let c = 0; c < ch; c++) (chunks[c] as Float32Array[]).push(new Float32Array(lost));
        from = written - capacity;
      }
      const n = written - from;
      const out = Array.from({ length: ch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) {
        const o = ((from + i) % capacity) * ch;
        for (let c = 0; c < ch; c++) (out[c] as Float32Array)[i] = ring[o + c] as number;
        let v = 0;
        for (let c = 0; c < ch; c++) v += ring[o + c] as number;
        v /= ch;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        if (++bucketFill === CAPTURE_BUCKET) pushPeak();
      }
      for (let c = 0; c < ch; c++) (chunks[c] as Float32Array[]).push(out[c] as Float32Array);
      read = written;
    };
    const timer = setInterval(drain, DRAIN_MS);

    const finish = (): CapturedAudio => {
      done = true;
      clearInterval(timer);
      drain();
      Atomics.store(state, IN_STATE.mode, IN_MODE.meter);
      const total = read;
      const channels = chunks.map((list) => {
        const all = new Float32Array(total);
        let o = 0;
        for (const part of list) {
          all.set(part.subarray(0, Math.min(part.length, total - o)), o);
          o += part.length;
        }
        return all;
      });
      if (capture === c) capture = null;
      return { channels, sampleRate: sr, startTime: (start[0] as number) / sr, dropped };
    };

    const c: AudioCapture & { drain(): void } = {
      sampleRate: sr,
      channelCount: ch,
      get startTime() {
        return Atomics.load(state, IN_STATE.written) > 0 || read > 0 ? (start[0] as number) / sr : NaN;
      },
      get frames() {
        return read;
      },
      get peaks() {
        return peaks;
      },
      get buckets() {
        return buckets;
      },
      bucket: CAPTURE_BUCKET,
      drain,
      stop(tail = 0) {
        if (done) return Promise.reject(new Error('The capture has already ended.'));
        return new Promise((resolve) => setTimeout(() => resolve(finish()), Math.max(0, tail * 1000)));
      },
      cancel() {
        if (done) return;
        done = true;
        clearInterval(timer);
        Atomics.store(state, IN_STATE.mode, IN_MODE.meter);
        if (capture === c) capture = null;
      },
    };
    capture = c;
    return c;
  };

  const trackLatency = Math.max(0, opts.latency ?? 0);
  return {
    channelCount: ch,
    label: opts.label ?? 'Audio input',
    get estimatedLatency() {
      return deps.outputLatency() + trackLatency;
    },
    get closed() {
      return closed;
    },
    levels(out) {
      let l = 0;
      let r = 0;
      for (let b = 0; b < LEVEL_BLOCKS; b++) {
        l = Math.max(l, levelRing[b * 2] as number);
        r = Math.max(r, levelRing[b * 2 + 1] as number);
      }
      out[0] = l;
      out[1] = ch === 1 ? l : r;
    },
    setMonitor,
    startCapture,
    close() {
      if (closed) return;
      capture?.cancel();
      setMonitor(null);
      closed = true;
      Atomics.store(state, IN_STATE.mode, IN_MODE.closed);
      source.disconnect();
      node.disconnect();
      sink.disconnect();
    },
  };
}
