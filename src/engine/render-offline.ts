import type { Project } from '@core/model/types';
import type { EngineOptions, TransportView } from './api';
import { Engine } from './engine';

export interface RenderOptions extends EngineOptions {
  view: TransportView;
  /** Length to render, in bars of the current pattern/song. */
  bars: number;
  sampleRate?: number;
  /** Silence before the first note, in seconds (default 2048 frames). */
  preRoll?: number;
  /** Extra seconds after the last bar for release tails (default 1). */
  tail?: number;
  /** Render chunk in frames (multiple of 128). */
  chunk?: number;
}

export interface RenderResult {
  buffer: AudioBuffer;
  /** Seconds of silence before the music starts. */
  preRoll: number;
  /** False if a worklet sync barrier timed out (worklet notes may be late). */
  synced: boolean;
}

/**
 * Renders with an OfflineAudioContext using the same engine code as playback. Rendering is chunked
 * with suspend()/resume(): while suspended the transport schedules the next chunk and every
 * worklet processor confirms (sync barrier) it has received its notes before rendering continues.
 */
export async function renderOffline(project: Project, opts: RenderOptions): Promise<RenderResult> {
  const sampleRate = opts.sampleRate ?? 48000;
  const ts = project.transport.timeSig;
  const barSeconds = (ts.num * 4 * 60) / (ts.den * project.transport.bpm);
  const preRoll = opts.preRoll ?? 2048 / sampleRate;
  const musical = opts.bars * barSeconds;
  const length = Math.ceil((preRoll + musical + (opts.tail ?? 1)) * sampleRate);
  const chunk = opts.chunk ?? 128 * 256;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const engine = new Engine(ctx, opts, true);
  engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
  engine.setTransportView(opts.view);
  await engine.ready();

  const end = preRoll + musical - 1e-6;
  let synced = true;
  engine.startOffline(0, preRoll);
  const step = async (frame: number) => {
    const next = frame + chunk;
    engine.pumpOffline(Math.min(end, next / sampleRate + 0.05));
    if (!(await engine.syncWorklets())) synced = false;
    if (next < length) void ctx.suspend(next / sampleRate).then(() => step(next));
    await ctx.resume();
  };
  // The first stop comes one quantum in: processors exist by then and the pre-roll covers it.
  void ctx.suspend(128 / sampleRate).then(() => step(128));
  const buffer = await ctx.startRendering();
  await engine.dispose();
  return { buffer, preRoll, synced };
}
