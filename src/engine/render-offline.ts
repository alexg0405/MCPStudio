import type { Project } from '@core/model/types';
import type { EngineOptions, TransportView } from './api';
import { Engine } from './engine';

export interface RenderOptions extends EngineOptions {
  view: TransportView;
  /** Length to render, in bars of the current pattern/song. */
  bars: number;
  sampleRate?: number;
  /** Silence before the first note, in seconds (default 0). */
  preRoll?: number;
  /** Extra seconds after the last bar for release tails (default: the plugins' tail times). */
  tail?: number;
}

/**
 * Renders the project with an OfflineAudioContext using the same engine code as playback.
 * v1 schedules everything up front (fine for graph plugins); chunked rendering for worklet plugins
 * comes with WAV export (M6).
 */
export async function renderOffline(project: Project, opts: RenderOptions): Promise<AudioBuffer> {
  const sampleRate = opts.sampleRate ?? 48000;
  const barSeconds = (project.transport.timeSig.num * 4 * 60) / (project.transport.timeSig.den * project.transport.bpm);
  const preRoll = opts.preRoll ?? 0;
  const musical = opts.bars * barSeconds;
  const tail = opts.tail ?? 1;
  const length = Math.ceil((preRoll + musical + tail) * sampleRate);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const engine = new Engine(ctx, opts, true);
  engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
  engine.setTransportView(opts.view);
  await engine.ready();
  // Stop scheduling at the end of the last bar; notes still release into the tail.
  engine.scheduleOffline(0, preRoll, preRoll + musical - 1e-6);
  const buffer = await ctx.startRendering();
  await engine.dispose();
  return buffer;
}
