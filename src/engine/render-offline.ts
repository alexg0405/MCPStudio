import type { Project } from '@core/model/types';
import type { EngineOptions, TransportView } from './api';
import { tempoMapOf } from '@core/automation/tempo';
import { ticksPerBar } from '@core/time/ppq';
import { Engine } from './engine';

export interface RenderOptions extends EngineOptions {
  view: TransportView;
  /** Length to render, in bars of the current pattern/song (fractions allowed). */
  bars: number;
  /** Where rendering starts, in ticks (default 0). */
  fromTick?: number;
  sampleRate?: number;
  /** Silence before the first note, in seconds (default 2048 frames). */
  preRoll?: number;
  /**
   * Extra seconds after the last bar for release and effect tails (default 1). 'auto' asks the
   * project's instruments and effects (capped at 30 s).
   */
  tail?: number | 'auto';
  /** Render chunk in frames (multiple of 128). */
  chunk?: number;
  /** Called after each chunk with the rendered fraction (0..1). */
  onProgress?(fraction: number): void;
  /** Aborting rejects with the signal's reason (an AbortError by default). */
  signal?: AbortSignal;
  /**
   * The master safety limiter (−0.3 dBFS, 1.3 ms look-ahead). On by default; renders that become
   * audio clips again (freeze, consolidate) or raw stems leave it out.
   */
  limiter?: boolean;
}

export interface RenderResult {
  buffer: AudioBuffer;
  /** Seconds of silence before the music starts. */
  preRoll: number;
  /**
   * Seconds the mixer delays everything by (plugin delay compensation): the music is heard from
   * `preRoll + latency`. Not trimmed here; exports may drop it along with the pre-roll.
   */
  latency: number;
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
  const preRoll = opts.preRoll ?? 2048 / sampleRate;
  // The rendered span follows the tempo map (tempo automation in song mode).
  const from = opts.fromTick ?? 0;
  const tempo = tempoMapOf(project, opts.view.mode);
  const musical = tempo.tickToSeconds(from + opts.bars * ticksPerBar(ts)) - tempo.tickToSeconds(from);
  const tail = opts.tail === 'auto' ? await measureTail(project, opts, sampleRate) : (opts.tail ?? 1);
  opts.signal?.throwIfAborted();
  const length = Math.ceil((preRoll + musical + tail) * sampleRate);
  const chunk = opts.chunk ?? 128 * 256;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const engine = new Engine(ctx, opts, true, { limiter: opts.limiter ?? true });
  try {
    engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
    engine.setTransportView(opts.view);
    await engine.ready();

    const end = preRoll + musical - 1e-6;
    let synced = true;
    // Long songs are decoded around what is being rendered: each chunk's clips are made ready
    // (decoded, stretched) before they are scheduled.
    await engine.prepareTicks(from, tempo.secondsToTick(tempo.tickToSeconds(from) + 1));
    engine.startOffline(from, preRoll);
    const step = async (frame: number) => {
      // Aborted: the context stays suspended and is dropped; `aborted` below rejects.
      if (opts.signal?.aborted) return;
      const next = frame + chunk;
      const horizon = Math.min(end, next / sampleRate + 0.05);
      await engine.prepareOffline(horizon + 0.05);
      engine.pumpOffline(horizon);
      if (!(await engine.syncWorklets())) synced = false;
      opts.onProgress?.(Math.min(1, frame / length));
      if (next < length) void ctx.suspend(next / sampleRate).then(() => step(next));
      await ctx.resume();
    };
    const aborted = new Promise<never>((_, reject) => {
      const signal = opts.signal;
      if (!signal) return;
      const fail = () => reject(signal.reason ?? new DOMException('Rendering was cancelled.', 'AbortError'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
    // The first stop comes one quantum in: processors exist by then and the pre-roll covers it.
    void ctx.suspend(128 / sampleRate).then(() => step(128));
    const buffer = await Promise.race([ctx.startRendering(), aborted]);
    opts.onProgress?.(1);
    return { buffer, preRoll, synced, latency: engine.graphLatency() };
  } finally {
    await engine.dispose();
  }
}

/**
 * Release and effect tails of the project's instruments and effects (seconds, capped at 30 s, plus
 * the mixer's latency), measured on a tiny context. Renders of variants of one project (stems) pass
 * the same number so their files come out the same length.
 */
export async function measureTail(project: Project, opts: EngineOptions, sampleRate: number): Promise<number> {
  const probe = new Engine(new OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate }), opts, true);
  try {
    probe.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
    await probe.ready();
    return probe.tailSeconds();
  } finally {
    await probe.dispose();
  }
}
