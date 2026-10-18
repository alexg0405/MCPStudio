/**
 * One instance of a compiled Faust DSP: its own WebAssembly memory and channel buffers.
 *
 * Memory layout (as faustwasm lays it out): the DSP struct at address 0 (`meta.size` bytes), then
 * the input and output channel pointer arrays, then one 128-frame float buffer per channel.
 */
import type { FaustMeta } from './params';
import { faustImports } from './wasm-imports';

/** Frames per compute call (the size of each wasm channel buffer). */
export const FAUST_BLOCK_FRAMES = 128;

/** Where the DSP struct lives in the module's memory. */
const DSP_ADDRESS = 0;
const BYTES_PER_FLOAT = 4;
const BYTES_PER_POINTER = 4;
const WASM_PAGE_BYTES = 65536;

interface FaustExports {
  memory: WebAssembly.Memory;
  init(dsp: number, sampleRate: number): void;
  instanceClear(dsp: number): void;
  compute(dsp: number, count: number, inputs: number, outputs: number): void;
  setParamValue(dsp: number, index: number, value: number): void;
}

function roundUpTo(bytes: number, multiple: number): number {
  return Math.ceil(bytes / multiple) * multiple;
}

/** One instance of the DSP with its own memory and channel buffers. */
export class FaustInstance {
  private readonly exports: FaustExports;
  private readonly inputPointers: number;
  private readonly outputPointers: number;
  /** The input channels' buffers: fill the first `count` frames before `compute(count)`. */
  readonly inputs: Float32Array[] = [];
  /** The output channels' buffers: `compute(count)` leaves its first `count` frames here. */
  readonly outputs: Float32Array[] = [];

  constructor(module: WebAssembly.Module, meta: FaustMeta, sampleRate: number) {
    this.exports = new WebAssembly.Instance(module, faustImports()).exports as unknown as FaustExports;
    const memory = this.exports.memory;
    this.inputPointers = roundUpTo(meta.size, 8);
    this.outputPointers = this.inputPointers + BYTES_PER_POINTER * meta.inputs;
    const buffersStart = roundUpTo(this.outputPointers + BYTES_PER_POINTER * meta.outputs, 16);
    const channelCount = meta.inputs + meta.outputs;
    const memoryEnd = buffersStart + channelCount * FAUST_BLOCK_FRAMES * BYTES_PER_FLOAT;
    if (memory.buffer.byteLength < memoryEnd) memory.grow(Math.ceil((memoryEnd - memory.buffer.byteLength) / WASM_PAGE_BYTES));
    const pointerWords = new Int32Array(memory.buffer);
    for (let channel = 0; channel < channelCount; channel++) {
      const bufferAddress = buffersStart + channel * FAUST_BLOCK_FRAMES * BYTES_PER_FLOAT;
      pointerWords[(this.inputPointers >> 2) + channel] = bufferAddress;
      const isInput = channel < meta.inputs;
      (isInput ? this.inputs : this.outputs).push(new Float32Array(memory.buffer, bufferAddress, FAUST_BLOCK_FRAMES));
    }
    this.exports.init(DSP_ADDRESS, sampleRate);
  }

  /** Sets a control by the memory offset Faust's JSON gives it. */
  set(controlIndex: number, value: number): void {
    this.exports.setParamValue(DSP_ADDRESS, controlIndex, value);
  }

  /** Clears the DSP's delay lines and filter state. */
  clear(): void {
    this.exports.instanceClear(DSP_ADDRESS);
  }

  /** Runs `count` (at most 128) frames: inputs from `this.inputs`, results in `this.outputs`. */
  compute(count: number): void {
    this.exports.compute(DSP_ADDRESS, count, this.inputPointers, this.outputPointers);
  }
}
