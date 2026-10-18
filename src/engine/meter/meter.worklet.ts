import { METER_ID, viewsOf, type MeterMemory } from './layout';
import { MeterKernel } from './suite.kernel';

/**
 * The metering suite as an AudioWorklet node: it measures its input (loudness, true peak, stereo, spectrum) and
 * writes the numbers into shared memory for the frame loop to read: no messages and no allocation on the audio
 * thread. It makes no sound; the main thread closes it (readings.closed) when nobody watches, and it ends.
 */
class MeterProcessor extends AudioWorkletProcessor {
  private readonly kernel: MeterKernel;

  constructor(options: { processorOptions?: unknown }) {
    super();
    const memory = (options.processorOptions as { memory: MeterMemory }).memory;
    this.kernel = new MeterKernel(sampleRate, viewsOf(memory));
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.kernel.closed) return false;
    const input = inputs[0];
    const n = input && input[0] ? input[0].length : 128;
    this.kernel.process(input?.[0], input?.[1], n);
    return true;
  }
}

registerProcessor(METER_ID, MeterProcessor);
