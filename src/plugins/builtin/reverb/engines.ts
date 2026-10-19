import type { WorkletPort } from '@agstudio/sdk';
import { createConvolution, type ConvolutionEngine, type ReverbHost } from './convolution';
import type { ReverbEngine } from './params';
import { createTimers } from './timers';

/** Crossfade when the Engine changes, seconds. */
const ENGINE_FADE_SEC = 0.05;
/** Extra time before the engine that faded out is stopped, so the fade has certainly finished, milliseconds. */
const FADE_OUT_MARGIN_MS = 60;

/** What the Reverb's main file keeps of the two engines. */
export interface ReverbEngines {
  /** Clears both tails. */
  reset(): void;
  dispose(): void;
}

/** An open convolution engine and the gain that fades it against the algorithmic one. */
interface OpenConvolution extends ConvolutionEngine {
  fade: GainNode;
}

/** Fades `param` to `target` over the engine crossfade, starting at `time`. */
function fadeTo(param: AudioParam, target: number, time: number): void {
  param.cancelAndHoldAtTime(time);
  param.linearRampToValueAtTime(target, time + ENGINE_FADE_SEC);
}

/**
 * The two engines behind the same knobs, and the switch between them. The algorithmic kernel is always built; the
 * convolution engine only exists while it is chosen (or fading out). Switching crossfades the two, and the engine
 * faded out stops getting input (an unfed kernel sleeps once its tail is over) or is torn down.
 */
export function createEngines(host: ReverbHost, kernel: WorkletPort, input: GainNode, output: GainNode): ReverbEngines {
  const ac = host.audioContext;
  const params = host.params;
  const timers = createTimers();

  let engine: ReverbEngine = params.engine.value;
  const algorithmic = new GainNode(ac, { gain: engine === 'algorithmic' ? 1 : 0 });
  kernel.node.connect(algorithmic).connect(output);

  let isKernelFed = false;
  const feedKernel = (on: boolean) => {
    if (isKernelFed === on) return;
    isKernelFed = on;
    if (on) input.connect(kernel.node);
    else input.disconnect(kernel.node);
  };
  feedKernel(engine === 'algorithmic');

  let convolution: OpenConvolution | null = null;
  const openConvolution = (fadeGain: number): OpenConvolution => {
    if (convolution) return convolution;
    const engineNodes = createConvolution(host);
    const fade = new GainNode(ac, { gain: fadeGain });
    engineNodes.output.connect(fade).connect(output);
    input.connect(engineNodes.input);
    return (convolution = { ...engineNodes, fade });
  };
  const closeConvolution = () => {
    if (!convolution) return;
    convolution.dispose();
    convolution.fade.disconnect();
    convolution = null;
  };
  if (engine === 'convolution') openConvolution(1);

  /** Once the fade that started at `time` is over, the engine faded out stops getting input (or is torn down). */
  const stopFadedOutEngineAfter = (time: number): void => {
    const fadeEndsInMs = (time - ac.currentTime + ENGINE_FADE_SEC) * 1000;
    timers.later(fadeEndsInMs + FADE_OUT_MARGIN_MS, () => {
      if (engine === 'algorithmic') closeConvolution();
      else feedKernel(false);
    });
  };

  /** Switching to the algorithmic engine: the kernel fades in, the convolution engine fades out and is closed. */
  const switchToAlgorithmic = (time: number, isImmediate: boolean): void => {
    feedKernel(true);
    if (isImmediate || !convolution) {
      algorithmic.gain.value = 1;
      closeConvolution();
      return;
    }
    fadeTo(algorithmic.gain, 1, time);
    fadeTo(convolution.fade.gain, 0, time);
    stopFadedOutEngineAfter(time);
  };

  /** Switching to the convolution engine: it fades in, the kernel fades out and stops being fed. */
  const switchToConvolution = (time: number, isImmediate: boolean): void => {
    const opened = openConvolution(isImmediate ? 1 : 0);
    if (isImmediate) {
      algorithmic.gain.value = 0;
      feedKernel(false);
      return;
    }
    fadeTo(opened.fade.gain, 1, time);
    fadeTo(algorithmic.gain, 0, time);
    stopFadedOutEngineAfter(time);
  };

  const switchTo = (next: ReverbEngine, time: number) => {
    if (next === engine) return;
    engine = next;
    const isImmediate = host.offline || ac.currentTime === 0;
    const fadeStart = Math.max(time, ac.currentTime);
    if (next === 'algorithmic') switchToAlgorithmic(fadeStart, isImmediate);
    else switchToConvolution(fadeStart, isImmediate);
  };
  const stopListening = params.engine.onChange((value, time) => switchTo(value, time));

  return {
    reset() {
      kernel.reset();
      convolution?.reset();
    },
    dispose() {
      stopListening();
      timers.clear();
      closeConvolution();
      algorithmic.disconnect();
    },
  };
}
