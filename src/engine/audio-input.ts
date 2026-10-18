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
/** How often a capture drains the ring into chunks (ms): the ring holds 30 s, so there is a lot of slack. */
const DRAIN_MS = 50;
/** Frames per [min, max] pair of the live peak overview. */
export const CAPTURE_BUCKET = 256;

/** The result of a finished capture. */
export interface CapturedAudio {
  /** One array per channel, from the first captured frame. */
  channels: Float32Array[];
  sampleRate: number;
  /** AudioContext time of the first frame. */
  startTime: number;
  /** Frames lost because the main thread didn't drain the ring in time (filled with silence). */
  dropped: number;
}

/** A capture in progress: a take of any length streamed from the input. */
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

/** A live input opened on the engine's clock. */
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

/** What an audio input needs from the engine. */
export interface AudioInputDeps {
  loadModule(url: string): Promise<void>;
  insertInput(id: InsertId): AudioNode;
  /** Output side of the round trip (seconds): output latency and the limiter. */
  outputLatency(): number;
}

/** True where shared memory exists (cross-origin isolation): the worklet writes into shared memory. */
export function canCapture(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  );
}

/** Int32 slots of the recorder's shared state (see IN_STATE). */
const STATE_SLOTS = 4;
/** Bytes of a 32-bit float or integer. */
const BYTES_PER_VALUE = 4;
/** The slot of the shared state that holds the first frame's context frame number: one 64-bit float. */
const START_BYTES = 8;
/** Initial size of a capture's live peak overview, in floats (it doubles when full). */
const INITIAL_PEAKS_FLOATS = 1024;
/** `written` value before the worklet has written a frame of the current capture. */
const NOTHING_WRITTEN = -1;

/** The shared memory the input worklet writes into, with views of it for this side. */
class SharedRing {
  /** Frames the ring holds before it overwrites the oldest. */
  readonly capacity: number;
  /** The audio, interleaved: `channels` values per frame. */
  readonly samples: Float32Array;
  readonly state: Int32Array;
  /** Context frame of the first recorded frame (slot 0). */
  readonly start: Float64Array;
  /** Peak levels per block and channel, for the meter. */
  readonly levels: Float32Array;
  private readonly buffers: { data: SharedArrayBuffer; state: SharedArrayBuffer; start: SharedArrayBuffer; levels: SharedArrayBuffer };

  constructor(
    sampleRate: number,
    readonly channels: number,
  ) {
    this.capacity = Math.round(RING_SECONDS * sampleRate);
    this.buffers = {
      data: new SharedArrayBuffer(this.capacity * channels * BYTES_PER_VALUE),
      state: new SharedArrayBuffer(STATE_SLOTS * BYTES_PER_VALUE),
      start: new SharedArrayBuffer(START_BYTES),
      levels: new SharedArrayBuffer(LEVEL_BLOCKS * 2 * BYTES_PER_VALUE),
    };
    this.samples = new Float32Array(this.buffers.data);
    this.state = new Int32Array(this.buffers.state);
    this.start = new Float64Array(this.buffers.start);
    this.levels = new Float32Array(this.buffers.levels);
  }

  /** What the worklet processor is started with. */
  get processorOptions(): { data: SharedArrayBuffer; state: SharedArrayBuffer; start: SharedArrayBuffer; levels: SharedArrayBuffer; channels: number } {
    return { ...this.buffers, channels: this.channels };
  }
}

/**
 * One take: drains the ring every DRAIN_MS into chunks (so a take is limited only by memory) and keeps a live
 * peak overview for drawing.
 */
class RingCapture implements AudioCapture {
  readonly bucket = CAPTURE_BUCKET;
  readonly sampleRate: number;
  readonly channelCount: number;
  /** One list of chunks per channel. */
  private readonly chunks: Float32Array[][];
  /** Frames read from the ring so far. */
  private framesRead = 0;
  private dropped = 0;
  private peakValues = new Float32Array(INITIAL_PEAKS_FLOATS);
  private bucketCount = 0;
  /** Frames in the bucket being filled, and its lowest and highest value so far. */
  private bucketFill = 0;
  private low = 0;
  private high = 0;
  private done = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly ring: SharedRing,
    sampleRate: number,
    /** Called once when the capture ends (finished or cancelled). */
    private readonly onEnd: (capture: RingCapture) => void,
  ) {
    this.sampleRate = sampleRate;
    this.channelCount = ring.channels;
    this.chunks = Array.from({ length: ring.channels }, () => []);
    Atomics.store(ring.state, IN_STATE.written, NOTHING_WRITTEN);
    Atomics.store(ring.state, IN_STATE.mode, IN_MODE.recording);
    this.timer = setInterval(() => this.drain(), DRAIN_MS);
  }

  get startTime(): number {
    const hasFrames = Atomics.load(this.ring.state, IN_STATE.written) > 0 || this.framesRead > 0;
    return hasFrames ? (this.ring.start[0] as number) / this.sampleRate : Number.NaN;
  }

  get frames(): number {
    return this.framesRead;
  }

  get peaks(): Float32Array {
    return this.peakValues;
  }

  get buckets(): number {
    return this.bucketCount;
  }

  stop(tail = 0): Promise<CapturedAudio> {
    if (this.done) return Promise.reject(new Error('The capture has already ended.'));
    return new Promise((resolve) => setTimeout(() => resolve(this.finish()), Math.max(0, tail * 1000)));
  }

  cancel(): void {
    if (this.done) return;
    this.done = true;
    clearInterval(this.timer);
    Atomics.store(this.ring.state, IN_STATE.mode, IN_MODE.meter);
    this.onEnd(this);
  }

  /** Moves what the worklet has written since the last drain from the ring into chunks. */
  drain(): void {
    const { state, samples, capacity, channels } = this.ring;
    const written = Atomics.load(state, IN_STATE.written);
    if (written <= this.framesRead) return;
    let from = this.framesRead;
    if (written - this.framesRead > capacity) {
      // The main thread stalled longer than the ring: those frames are lost; keep time with silence.
      const lost = written - this.framesRead - capacity;
      this.dropped += lost;
      for (let c = 0; c < channels; c++) (this.chunks[c] as Float32Array[]).push(new Float32Array(lost));
      from = written - capacity;
    }
    const frameCount = written - from;
    const out = Array.from({ length: channels }, () => new Float32Array(frameCount));
    for (let i = 0; i < frameCount; i++) {
      const base = ((from + i) % capacity) * channels;
      for (let c = 0; c < channels; c++) (out[c] as Float32Array)[i] = samples[base + c] as number;
      this.addToOverview(this.meanOfFrame(base));
    }
    for (let c = 0; c < channels; c++) (this.chunks[c] as Float32Array[]).push(out[c] as Float32Array);
    this.framesRead = written;
  }

  /** The mean of all channels of the frame whose first value is at `base` in the ring. */
  private meanOfFrame(base: number): number {
    const { samples, channels } = this.ring;
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[base + c] as number;
    return sum / channels;
  }

  /** Folds a frame into the bucket being filled; a full bucket is pushed to the overview. */
  private addToOverview(value: number): void {
    if (value < this.low) this.low = value;
    if (value > this.high) this.high = value;
    if (++this.bucketFill === CAPTURE_BUCKET) this.pushBucket();
  }

  private pushBucket(): void {
    if (this.bucketCount * 2 + 2 > this.peakValues.length) {
      const grown = new Float32Array(this.peakValues.length * 2);
      grown.set(this.peakValues);
      this.peakValues = grown;
    }
    this.peakValues[this.bucketCount * 2] = this.low;
    this.peakValues[this.bucketCount * 2 + 1] = this.high;
    this.bucketCount++;
    this.bucketFill = 0;
    this.low = 0;
    this.high = 0;
  }

  /** Ends the take: the last drain, then all chunks joined per channel. */
  private finish(): CapturedAudio {
    this.done = true;
    clearInterval(this.timer);
    this.drain();
    Atomics.store(this.ring.state, IN_STATE.mode, IN_MODE.meter);
    const total = this.framesRead;
    const channels = this.chunks.map((list) => {
      const all = new Float32Array(total);
      let offset = 0;
      for (const part of list) {
        all.set(part.subarray(0, Math.min(part.length, total - offset)), offset);
        offset += part.length;
      }
      return all;
    });
    this.onEnd(this);
    return {
      channels,
      sampleRate: this.sampleRate,
      startTime: (this.ring.start[0] as number) / this.sampleRate,
      dropped: this.dropped,
    };
  }
}

/** A live input: the worklet that records it, its meter, its monitoring path and its captures. */
class LiveAudioInput implements AudioInput {
  readonly channelCount: 1 | 2;
  readonly label: string;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly node: AudioWorkletNode;
  /** A silent path to the destination keeps the recorder running. */
  private readonly sink: GainNode;
  private readonly monitor: GainNode;
  private monitorTo: AudioNode | null = null;
  private capture: RingCapture | null = null;
  private isClosed = false;
  /** The input's own latency as the browser reports it (seconds). */
  private readonly inputLatencySec: number;

  constructor(
    private readonly ctx: AudioContext,
    private readonly deps: AudioInputDeps,
    private readonly ring: SharedRing,
    stream: MediaStream,
    opts: { channels: 1 | 2; label?: string; latency?: number },
  ) {
    this.channelCount = opts.channels;
    this.label = opts.label ?? 'Audio input';
    this.inputLatencySec = Math.max(0, opts.latency ?? 0);
    this.source = new MediaStreamAudioSourceNode(ctx, { mediaStream: stream });
    this.node = new AudioWorkletNode(ctx, INPUT_RECORDER_ID, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: opts.channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: ring.processorOptions,
    });
    this.sink = new GainNode(ctx, { gain: 0 });
    this.source.connect(this.node).connect(this.sink).connect(ctx.destination);
    this.monitor = new GainNode(ctx, { gain: 1 });
  }

  get estimatedLatency(): number {
    return this.deps.outputLatency() + this.inputLatencySec;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  levels(out: Float32Array): void {
    let left = 0;
    let right = 0;
    for (let block = 0; block < LEVEL_BLOCKS; block++) {
      left = Math.max(left, this.ring.levels[block * 2] as number);
      right = Math.max(right, this.ring.levels[block * 2 + 1] as number);
    }
    out[0] = left;
    out[1] = this.channelCount === 1 ? left : right;
  }

  setMonitor(track: InsertId | null, gain = 1): void {
    if (this.isClosed) return;
    if (this.monitorTo) {
      this.source.disconnect(this.monitor);
      this.monitor.disconnect();
      this.monitorTo = null;
    }
    if (track === null) return;
    this.monitor.gain.value = gain;
    this.monitorTo = this.deps.insertInput(track);
    this.source.connect(this.monitor).connect(this.monitorTo);
  }

  startCapture(): AudioCapture {
    if (this.isClosed) throw new Error('The audio input is closed.');
    this.capture?.cancel();
    const capture = new RingCapture(this.ring, this.ctx.sampleRate, (ended) => {
      if (this.capture === ended) this.capture = null;
    });
    this.capture = capture;
    return capture;
  }

  close(): void {
    if (this.isClosed) return;
    this.capture?.cancel();
    this.setMonitor(null);
    this.isClosed = true;
    Atomics.store(this.ring.state, IN_STATE.mode, IN_MODE.closed);
    this.source.disconnect();
    this.node.disconnect();
    this.sink.disconnect();
  }
}

/** Opens a live input on the engine's clock. Rejects where shared memory is not available. */
export async function openAudioInput(
  ctx: AudioContext,
  deps: AudioInputDeps,
  stream: MediaStream,
  opts: { channels: 1 | 2; label?: string; latency?: number },
): Promise<AudioInput> {
  if (!canCapture())
    throw new Error('Recording needs cross-origin isolation: run AGstudio from its own dev or preview server.');
  await deps.loadModule(inputRecorderUrl);
  const ring = new SharedRing(ctx.sampleRate, opts.channels);
  return new LiveAudioInput(ctx, deps, ring, stream, opts);
}
