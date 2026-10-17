/**
 * Test-only output probe for the latency measurements (test/helpers/latency.ts). It sits behind the master
 * (after the limiter) and, while armed, records the context frame of the first sample louder than the threshold in
 * a shared Float64Array: [0] state (0 idle, 1 armed, 2 hit), [1] frame of the hit, [2] frame of the last block,
 * [3] blocks seen, [4] threshold. Main-thread writes and worklet reads are plain: a stale read only costs one block.
 */
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options: never) => AudioWorkletProcessor): void;

class Probe extends AudioWorkletProcessor {
  private readonly s: Float64Array;
  constructor(options: { processorOptions: { sab: SharedArrayBuffer } }) {
    super();
    this.s = new Float64Array(options.processorOptions.sab);
  }
  process(inputs: Float32Array[][]): boolean {
    const s = this.s;
    s[2] = currentFrame;
    s[3] = (s[3] as number) + 1;
    if (s[0] === 1) {
      const thr = s[4] as number;
      let best = Infinity;
      for (const ch of inputs[0] ?? []) {
        for (let i = 0; i < ch.length; i++) {
          if (Math.abs(ch[i] as number) > thr) {
            best = Math.min(best, currentFrame + i);
            break;
          }
        }
      }
      if (best < Infinity) {
        s[1] = best;
        s[0] = 2;
      }
    }
    return true;
  }
}
registerProcessor('latency-probe', Probe);
