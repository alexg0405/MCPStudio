/**
 * registerKernel(): turns a kernel class into an AudioWorkletProcessor. Call it once at the top of a
 * plugin's `*.worklet.ts` file with the same id as the plugin definition.
 *
 * AudioWorklet globals are accessed lazily through `globalThis`, so importing this module on the
 * main thread (types, tests) is harmless.
 */
import {
  descriptors,
  encode,
  isAutomatable,
  messageParamNames,
  type ParamDescriptorLike,
  type ParamSpecs,
} from '../params';
import { liteName, PITCH_PARAM, type FromProcessor, type ProcessorInit, type ToProcessor } from '../protocol';
import { Rng } from '../dsp/random';
import { InstrumentKernel, type KernelClass, type KernelHost } from './kernel';
import type { MessageParamInit } from './message-params';
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

/** How long a live edit of an automatable float takes to settle when its spec does not say, seconds. */
const DEFAULT_SMOOTHING_SEC = 0.008;
/** A change settles in about this many time constants (the host's smoothing is the settle time). */
const TIME_CONSTANTS_TO_SETTLE = 3;
/** Range of the channel pitch an instrument gets, in cents (8 octaves each way). */
const PITCH_RANGE_CENTS = 9600;

/** Time constant (seconds) of a live edit of an automatable float, as the host's AutoLane smooths an AudioParam. */
function glideOf(spec: ParamSpecs[string]): number {
  if (spec.type !== 'float' || !isAutomatable(spec)) return 0;
  return (spec.smoothing ?? DEFAULT_SMOOTHING_SEC) / TIME_CONSTANTS_TO_SETTLE;
}

/**
 * Registers a kernel under `id`: the full processor (automatable params are AudioParams) and the
 * lite one (`liteName(id)`, which takes every param as events). Registering an id twice in one
 * context keeps the first and warns.
 */
export function registerKernel<P extends ParamSpecs>(id: string, params: P, Kernel: KernelClass<P>): void {
  const scope = globalThis as unknown as WorkletScope;
  const registered = (scope.__agKernels ??= new Set<string>());
  if (registered.has(id)) {
    console.warn(`[agstudio] kernel "${id}" is already registered in this AudioContext; keeping the first one`);
    return;
  }
  registered.add(id);
  const instrument = Kernel.prototype instanceof InstrumentKernel;
  // The full processor: automatable params are AudioParams; the lite one takes them all as events.
  defineProcessor(scope, id, params, Kernel, { lite: false, instrument });
  defineProcessor(scope, liteName(id), params, Kernel, { lite: true, instrument });
}

/** The AudioParams a processor declares, and which params reach the kernel as events instead. */
function paramPlan(params: ParamSpecs, lite: boolean, instrument: boolean) {
  const paramDescriptors: ParamDescriptorLike[] = lite ? [] : descriptors(params);
  const audioParamNames = paramDescriptors.map((d) => d.name);
  // Event params, in the order the host sends their index in (the full processor's: the ones that
  // aren't AudioParams; the lite one's: all of them).
  const messageNames = lite ? Object.keys(params) : messageParamNames(params);
  // Instruments also get the channel pitch (cents), which the host feeds from host.channel.pitch.
  if (instrument)
    paramDescriptors.push({
      name: PITCH_PARAM,
      defaultValue: 0,
      minValue: -PITCH_RANGE_CENTS,
      maxValue: PITCH_RANGE_CENTS,
      automationRate: 'a-rate',
    });
  return { paramDescriptors, audioParamNames, messageNames };
}

/** Starting values of the event params: what the host sent (else the defaults), with their glide time constants. */
function startingMessageParams(
  params: ParamSpecs,
  messageNames: readonly string[],
  sent: Record<string, number>,
  lite: boolean,
): MessageParamInit[] {
  return messageNames.map((key) => {
    const spec = params[key] as ParamSpecs[string];
    return [key, sent[key] ?? encode(spec, spec.default), lite ? glideOf(spec) : 0] as const;
  });
}

function defineProcessor<P extends ParamSpecs>(
  scope: WorkletScope,
  name: string,
  params: P,
  Kernel: KernelClass<P>,
  { lite, instrument }: { lite: boolean; instrument: boolean },
): void {
  const { paramDescriptors, audioParamNames, messageNames } = paramPlan(params, lite, instrument);

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
      const messageParams = startingMessageParams(params, messageNames, init.params ?? {}, lite);
      this.runner = new KernelRunner(new Kernel(host), post, audioParamNames, messageParams);
      this.port.onmessage = (e: MessageEvent<ToProcessor>) => this.runner.onMessage(e.data);
      post({ t: 'ready' });
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
      return this.runner.process(inputs, outputs, parameters, scope.currentFrame);
    }
  }

  scope.registerProcessor(name, KernelProcessor);
}
