/** Renders part of the mix offline and measures its loudness, for leveling to listen with. */
import type { Project } from '@core/model/types';
import { renderOffline } from '@engine/render-offline';
import { Measurer, type Measurement } from '../../analysis/measure';
import type { Services } from '../../services';
import type { LevelWindow } from './listening-window';
import type { AutoLevelOptions } from './types';

/** The measurement is fed to the meter this many seconds of audio at a time, with a breath for the UI between. */
const MEASURE_CHUNK_SEC = 1;
/** Rendering is most of a step's work; measuring the rest. */
const RENDER_SHARE_OF_STEP = 0.8;

/** What to render and measure. */
export interface RenderRequest {
  label: string;
  /** Keep the engine's safety limiter on (off for the bus stems and the pre-master reading, so peaks stay as they are). */
  safetyLimiter: boolean;
  /** Also measure the true peak (it costs more). */
  truePeak: boolean;
}

/** Renders and measures one project at a time and reports progress over all the steps of a leveling. */
export interface MixRenderer {
  measure(project: Project, request: RenderRequest): Promise<Measurement>;
}

/** Lets the UI breathe between renders (not setTimeout: hidden tabs throttle it to a second). */
const yieldToUi = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(0);
  });
};

/**
 * Makes the renderer for one leveling. `totalSteps` is how many renders the leveling plans (progress runs 0…1 over
 * them); each `measure` waits for the music to stop first and can be stopped through `options.signal`.
 */
export function createMixRenderer(
  services: Services,
  options: AutoLevelOptions,
  part: LevelWindow,
  sampleRate: number,
  seconds: number,
  totalSteps: number,
): MixRenderer {
  const frames = Math.round(seconds * sampleRate);
  const chunkFrames = Math.round(MEASURE_CHUNK_SEC * sampleRate);
  let stepsDone = 0;
  const report = (label: string, stepFraction: number) =>
    options.progress?.(label, Math.min(1, (stepsDone + stepFraction) / totalSteps));

  async function measure(project: Project, request: RenderRequest): Promise<Measurement> {
    await options.whenQuiet?.();
    options.signal?.throwIfAborted();
    const rendered = await renderOffline(project, {
      plugins: services.plugins,
      sampleCache: services.sampleCache,
      view: { mode: part.mode, patternId: part.patternId, loop: null },
      bars: part.bars,
      fromTick: part.fromTick,
      sampleRate,
      tail: 0,
      limiter: request.safetyLimiter,
      onProgress: (fraction) => report(request.label, fraction * RENDER_SHARE_OF_STEP),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const firstFrame = Math.round((rendered.preRoll + rendered.latency) * sampleRate);
    const left = rendered.buffer.getChannelData(0).subarray(firstFrame, firstFrame + frames);
    const right =
      rendered.buffer.numberOfChannels > 1
        ? rendered.buffer.getChannelData(1).subarray(firstFrame, firstFrame + frames)
        : left;
    const measurer = new Measurer(sampleRate, request.truePeak);
    for (let from = 0; from < left.length; from += chunkFrames) {
      measurer.push(left, right, from, Math.min(left.length, from + chunkFrames));
      await yieldToUi();
      options.signal?.throwIfAborted();
    }
    stepsDone++;
    return measurer.result();
  }

  return { measure };
}
