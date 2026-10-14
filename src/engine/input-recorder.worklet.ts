import { IN_MODE, IN_STATE, INPUT_RECORDER_ID, LEVEL_BLOCKS } from './input-recorder-id';

/**
 * Streams its input into a SharedArrayBuffer ring (interleaved, `channels` per frame) for as long as
 * recording lasts; the main thread drains it in chunks, so a take can be any length. Always writes
 * each block's peak level per channel for the input meter. No allocation and no messages on the
 * audio thread.
 *
 * Timing: the context frame of the first recorded frame goes to `start`; every later block lands at
 * its own clock position, so when the input stalls (Chrome then gives the input zero channels) the
 * gap becomes silence and everything after it stays in time.
 */
interface InputRecorderOptions {
  data: SharedArrayBuffer;
  state: SharedArrayBuffer;
  start: SharedArrayBuffer;
  levels: SharedArrayBuffer;
  channels: number;
}

class InputRecorderProcessor extends AudioWorkletProcessor {
  private readonly data: Float32Array;
  private readonly state: Int32Array;
  private readonly start: Float64Array;
  private readonly levels: Float32Array;
  private readonly channels: number;
  private readonly capacity: number;
  private started = false;

  constructor(options: { processorOptions?: unknown }) {
    super();
    const o = options.processorOptions as InputRecorderOptions;
    this.data = new Float32Array(o.data);
    this.state = new Int32Array(o.state);
    this.start = new Float64Array(o.start);
    this.levels = new Float32Array(o.levels);
    this.channels = o.channels;
    this.capacity = Math.floor(this.data.length / this.channels);
  }

  process(inputs: Float32Array[][]): boolean {
    const mode = Atomics.load(this.state, IN_STATE.mode);
    if (mode === IN_MODE.closed) return false;
    const input = inputs[0];
    const have = input ? input.length : 0;
    const first = have > 0 ? (input as Float32Array[])[0] : undefined;
    const n = first ? first.length : 128;
    const ch = this.channels;
    // Meter: this block's peak per channel.
    const blocks = Atomics.load(this.state, IN_STATE.blocks);
    const slot = (blocks % LEVEL_BLOCKS) * 2;
    for (let c = 0; c < 2; c++) {
      let peak = 0;
      const src = c < have ? (input as Float32Array[])[c] : c === 1 && have === 1 ? first : undefined;
      if (src) for (let i = 0; i < n; i++) {
        const v = src[i] as number;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      this.levels[slot + c] = peak;
    }
    Atomics.store(this.state, IN_STATE.blocks, blocks + 1);
    if (mode !== IN_MODE.recording) return true;

    let w = Atomics.load(this.state, IN_STATE.written);
    // A new capture (the main thread sets `written` to −1 before switching to recording).
    if (!this.started || w < 0) {
      this.started = true;
      this.start[0] = currentFrame;
      w = 0;
    } else {
      // Blocks the stream didn't deliver become silence (the ring keeps its clock position).
      const at = Math.round(currentFrame - (this.start[0] as number));
      for (; w < at; w++) {
        const o = (w % this.capacity) * ch;
        for (let c = 0; c < ch; c++) this.data[o + c] = 0;
      }
    }
    for (let i = 0; i < n; i++) {
      const o = ((w + i) % this.capacity) * ch;
      for (let c = 0; c < ch; c++) {
        const src = c < have ? (input as Float32Array[])[c] : first;
        this.data[o + c] = src ? (src[i] as number) : 0;
      }
    }
    Atomics.store(this.state, IN_STATE.written, w + n);
    return true;
  }
}

registerProcessor(INPUT_RECORDER_ID, InputRecorderProcessor);
