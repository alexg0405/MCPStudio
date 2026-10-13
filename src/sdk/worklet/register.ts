/**
 * registerKernel(): turns a kernel class into an AudioWorkletProcessor. Call it once at the top of a
 * plugin's `*.worklet.ts` file with the same id as the plugin definition.
 *
 * AudioWorklet globals are accessed lazily through `globalThis`, so importing this module on the
 * main thread (types, tests) is harmless.
 */
import { descriptors, type ParamSpecs } from '../params';
import { PITCH_PARAM, type FromProcessor, type ProcessorInit, type ToProcessor } from '../protocol';
import { Rng } from '../dsp/random';
import { InstrumentKernel, type KernelClass, type KernelHost } from './kernel';
import { KernelRunner } from './runner';

interface WorkletProcessorInstance {
  readonly port: MessagePort;
}

interface WorkletScope {
  registerProcessor(name: string, ctor: unknown): void;
  AudioWorkletProcessor: new () => WorkletProcessorInstance;
  currentFrame: number;
  sampleRate: number;
  __agKernels?: Set<string>;
}

interface ProcessorOptions {
  processorOptions?: Partial<ProcessorInit>;
}

export function registerKernel<P extends ParamSpecs>(id: string, params: P, Kernel: KernelClass<P>): void {
  const scope = globalThis as unknown as WorkletScope;
  const registered = (scope.__agKernels ??= new Set<string>());
  if (registered.has(id)) {
    console.warn(`[agstudio] kernel "${id}" is already registered in this AudioContext; keeping the first one`);
    return;
  }
  registered.add(id);
  const paramDescriptors = descriptors(params);
  // Instruments also get the channel pitch (cents), which the host feeds from host.channel.pitch.
  if (Kernel.prototype instanceof InstrumentKernel)
    paramDescriptors.push({
      name: PITCH_PARAM,
      defaultValue: 0,
      minValue: -9600,
      maxValue: 9600,
      automationRate: 'a-rate',
    });

  class KernelProcessor extends scope.AudioWorkletProcessor {
    static get parameterDescriptors() {
      return paramDescriptors;
    }

    private readonly runner: KernelRunner;

    constructor(options: ProcessorOptions) {
      super();
      const init = options?.processorOptions ?? {};
      const rng = new Rng(init.seed ?? 1);
      const post = (msg: FromProcessor) => this.port.postMessage(msg);
      const host: KernelHost = {
        sampleRate: scope.sampleRate,
        state: init.state,
        post: (msg) => post({ t: 'user', msg }),
        rand: () => rng.next(),
      };
      // If the kernel's constructor throws, so does this one: the node then fires `processorerror`
      // on the main thread and the host reports the plugin as faulted.
      this.runner = new KernelRunner(new Kernel(host), post);
      this.port.onmessage = (e: MessageEvent<ToProcessor>) => this.runner.onMessage(e.data);
      post({ t: 'ready' });
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
      return this.runner.process(inputs, outputs, parameters, scope.currentFrame);
    }
  }

  scope.registerProcessor(id, KernelProcessor);
}
