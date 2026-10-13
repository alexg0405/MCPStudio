import { REC_MODE, REC_STATE, RECORDER_ID } from './recorder-id';

/**
 * Records its (mono-mixed) input into a SharedArrayBuffer: no allocation and no messages on the
 * audio thread. The main thread arms it, reads the write position live (for meters) and copies
 * the samples out when it's done. The context frame of the first recorded sample goes to `start`.
 */
interface RecorderOptions {
  data: SharedArrayBuffer;
  state: SharedArrayBuffer;
  start: SharedArrayBuffer;
}

class RecorderProcessor extends AudioWorkletProcessor {
  private readonly data: Float32Array;
  private readonly state: Int32Array;
  private readonly start: Float64Array;

  constructor(options: { processorOptions?: unknown }) {
    super();
    const o = options.processorOptions as RecorderOptions;
    this.data = new Float32Array(o.data);
    this.state = new Int32Array(o.state);
    this.start = new Float64Array(o.start);
  }

  process(inputs: Float32Array[][]): boolean {
    const mode = Atomics.load(this.state, REC_STATE.mode);
    if (mode === REC_MODE.done) return false;
    if (mode !== REC_MODE.recording) return true;
    const input = inputs[0];
    const channels = input ? input.length : 0;
    const first = channels > 0 ? (input as Float32Array[])[0] : undefined;
    if (!first) return true;
    const n = first.length;
    const w = Atomics.load(this.state, REC_STATE.written);
    if (w === 0) this.start[0] = currentFrame;
    const m = Math.min(n, this.data.length - w);
    const inv = 1 / channels;
    for (let i = 0; i < m; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += (input as Float32Array[])[c]![i]!;
      this.data[w + i] = v * inv;
    }
    Atomics.store(this.state, REC_STATE.written, w + m);
    if (m < n) Atomics.store(this.state, REC_STATE.mode, REC_MODE.done);
    return true;
  }
}

registerProcessor(RECORDER_ID, RecorderProcessor);
