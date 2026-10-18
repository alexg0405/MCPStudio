/**
 * One render of an export, shared by the audio and the video export: the plan's range rendered window by
 * window (renderStream) and trimmed as it comes (StreamTrimmer: the pre-roll and the mixer's delay
 * compensation off the front, the silence after the last tail off the end), every kept piece of audio
 * handed to `consume` in order.
 */
import type { Project } from '@core/model/types';
import { renderStream } from '@engine/render-offline';
import type { Services } from '../services';
import { StreamTrimmer } from './stream-trim';
import type { ExportPlan } from './plan';

export interface RenderPassOptions {
  s: Services;
  /** The project to render (a stem's variant, the raw mix…). */
  project: Project;
  plan: ExportPlan;
  sampleRate: number;
  /** Seconds of tail to render after the music (`measureTail`; variants of one export share it). */
  tail: number;
  /** Frames of music always kept. */
  musicFrames: number;
  /** The master safety limiter (off for raw stems). */
  limiter: boolean;
  /** Keep exactly this many frames (stems share the mix's length) instead of trimming the tail. */
  length?: number | undefined;
  signal?: AbortSignal | undefined;
  /** The render's own progress, 0…1 (before any audio has been handed over for a window). */
  onRender?(fraction: number): void;
}

/** Renders and trims; returns the frames kept. */
export async function renderPass(
  o: RenderPassOptions,
  consume: (piece: Float32Array[]) => Promise<void>,
): Promise<number> {
  const { s, plan, sampleRate: rate, signal } = o;
  let trimmer: StreamTrimmer | null = null;
  const extra = Math.round(0.01 * rate);
  const r = await renderStream(o.project, {
    plugins: s.plugins,
    sampleCache: s.sampleCache,
    view: { mode: plan.mode, patternId: plan.patternId, loop: null },
    bars: plan.bars,
    fromTick: plan.fromTick,
    sampleRate: rate,
    tail: o.tail,
    limiter: o.limiter,
    ...(o.onRender ? { onProgress: o.onRender } : {}),
    ...(signal ? { signal } : {}),
    onAudio: async (channels, frame, info) => {
      // Every render of one export has the same start (pre-roll and delay compensation, see measureTail).
      trimmer ??= new StreamTrimmer(Math.round((info.preRoll + info.latency) * rate), o.musicFrames, {
        extra,
        ...(o.length !== undefined ? { length: o.length } : {}),
      });
      for (const piece of trimmer.push(channels, frame)) await consume(piece);
    },
  });
  signal?.throwIfAborted();
  const t = trimmer as StreamTrimmer | null;
  if (!t) return 0;
  for (const piece of t.finish(r.frames)) await consume(piece);
  return t.frames;
}
