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
  /** Silence before the first note, in seconds (default 2048 frames; renderStream: 0.25 s). */
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

interface Timing {
  sampleRate: number;
  preRoll: number;
  from: number;
  /** Seconds of music. */
  musical: number;
  tail: number;
  /** Frames of the whole render. */
  length: number;
}

async function timingOf(project: Project, opts: RenderOptions, defaultPreRoll: (sr: number) => number): Promise<Timing> {
  const sampleRate = opts.sampleRate ?? 48000;
  const ts = project.transport.timeSig;
  const preRoll = opts.preRoll ?? defaultPreRoll(sampleRate);
  // The rendered span follows the tempo map (tempo automation in song mode).
  const from = opts.fromTick ?? 0;
  const tempo = tempoMapOf(project, opts.view.mode);
  const musical = tempo.tickToSeconds(from + opts.bars * ticksPerBar(ts)) - tempo.tickToSeconds(from);
  const tail = opts.tail === 'auto' ? await measureTail(project, opts, sampleRate) : (opts.tail ?? 1);
  opts.signal?.throwIfAborted();
  return { sampleRate, preRoll, from, musical, tail, length: Math.ceil((preRoll + musical + tail) * sampleRate) };
}

/**
 * Renders frames [startFrame, startFrame + length) of the full render described by `t` in one
 * OfflineAudioContext. Context time 0 is full-render time startFrame / rate: a later window starts
 * the transport at the tick heard then, so every event lands on the same frame as in one long
 * render (bit for bit when the tempo's seconds per tick and the pre-roll are exact binary fractions,
 * e.g. 128 BPM). Rendering is chunked with suspend()/resume(): while suspended, the chunk's clips
 * are made ready (decoded, stretched), the transport schedules it and every worklet processor
 * confirms (sync barrier) it has received its notes before rendering continues.
 */
async function renderSpan(
  project: Project,
  opts: RenderOptions,
  t: Timing,
  startFrame: number,
  length: number,
  onProgress: (frames: number) => void,
): Promise<RenderResult> {
  const { sampleRate, preRoll, from } = t;
  const chunk = opts.chunk ?? 128 * 256;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const engine = new Engine(ctx, opts, true, { limiter: opts.limiter ?? true });
  const tempo = tempoMapOf(project, opts.view.mode);
  try {
    const offset = startFrame / sampleRate;
    const end = preRoll + t.musical - offset - 1e-6;
    let synced = true;
    // Where the transport starts: the song tick at context time 0 (or the pre-roll in the first window).
    const startSec = Math.max(0, offset - preRoll);
    const startTick = startSec > 0 ? tempo.secondsToTick(tempo.tickToSeconds(from) + startSec) : from;
    const startAt = startSec > 0 ? preRoll + startSec - offset : preRoll;
    engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
    engine.setTransportView(opts.view);
    // The samples around the start first (long songs aren't all decoded), then the plugins.
    const prepared = engine.prepareTicks(startTick, tempo.secondsToTick(tempo.tickToSeconds(startTick) + 1));
    await engine.ready();
    await prepared;
    if (end > 0) engine.startOffline(startTick, startAt);
    let musicEnded = false;
    const step = async (frame: number) => {
      // Aborted: the context stays suspended and is dropped; `aborted` below rejects.
      if (opts.signal?.aborted) return;
      const next = frame + chunk;
      const horizon = Math.min(end, next / sampleRate + 0.05);
      if (end > 0) {
        await engine.prepareOffline(horizon + 0.05);
        engine.pumpOffline(horizon);
        // The span's last notes are planned: whatever still sounds (or ends right here) stops now, so
        // the tail holds only what the sound itself leaves (releases, reverb), not held notes.
        if (!musicEnded && horizon >= end) {
          musicEnded = true;
          engine.endOffline(end);
        }
      }
      if (!(await engine.syncWorklets())) synced = false;
      onProgress(Math.min(length, frame));
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
    onProgress(length);
    return { buffer, preRoll, synced, latency: engine.graphLatency() };
  } finally {
    await engine.dispose();
  }
}

/**
 * Renders with an OfflineAudioContext using the same engine code as playback, in one piece (the
 * whole render is in memory: use renderStream for long songs).
 */
export async function renderOffline(project: Project, opts: RenderOptions): Promise<RenderResult> {
  const t = await timingOf(project, opts, (sr) => 2048 / sr);
  const r = await renderSpan(project, opts, t, 0, t.length, (f) => opts.onProgress?.(f / t.length));
  opts.onProgress?.(1);
  return r;
}

export interface StreamRenderOptions extends RenderOptions {
  /**
   * Seconds of output per render window (default 512). A render that fits in one window is one
   * render; longer ones are rendered window by window and never held whole.
   */
  windowSec?: number;
  /**
   * Gets the render in order, a piece (at most a second) at a time, with the frame it starts at.
   * The arrays are the caller's (transfer them, keep them). Awaited before the next piece. `info`:
   * where the music starts (pre-roll, and the mixer's delay compensation after it).
   */
  onAudio(channels: Float32Array[], frame: number, info: { preRoll: number; latency: number }): void | Promise<void>;
}

export interface StreamRenderResult {
  preRoll: number;
  latency: number;
  synced: boolean;
  /** Frames delivered (the whole render). */
  frames: number;
  sampleRate: number;
  /** Render windows used (1: a single render). */
  windows: number;
}

/**
 * The window grid: window starts are whole multiples of this many seconds, so every window is
 * aligned to the render quantum (128 frames) and its start time is an exact binary fraction; at 48
 * and 96 kHz also to the 16384-frame partitions of the convolver's longest FFT stage, so reverbs
 * come out bit for bit. (44.1 kHz can't have both in a usable grid: its reverb tails may differ from
 * a single render by rounding, far below hearing.)
 */
export function windowGrid(sampleRate: number): number {
  for (let g = 1; g <= 128; g *= 2) if ((g * sampleRate) % 16384 === 0) return g;
  for (let g = 1; g <= 1024; g *= 2) if ((g * sampleRate) % 128 === 0) return g;
  return 1;
}

/** Seconds the windows overlap by and crossfade (identical audio stays bit for bit). */
const CROSSFADE = 0.1;
/** Seconds of warm-up beyond the effects' tails (delays and filters settle completely). */
const SETTLE = 8;

/**
 * Renders like renderOffline but hands the audio over a piece at a time, so an hour-long mix
 * never sits in memory whole. Long renders go window by window (each a fresh engine and
 * OfflineAudioContext of about `windowSec`): every window starts early by the effects' tails plus a
 * few seconds (a warm-up that is thrown away), so reverbs, delays and notes that cross a window
 * boundary sound as in one render, and the windows overlap by 0.1 s with a crossfade that leaves
 * identical audio untouched. With exact timing (see renderSpan) the stitched result is the single
 * render bit for bit. Free-running modulation (an LFO's phase) restarts in each window: its seam
 * is the crossfade. Notes held longer than the warm-up across a boundary are not heard after it.
 */
export async function renderStream(project: Project, opts: StreamRenderOptions): Promise<StreamRenderResult> {
  const t = await timingOf(project, opts, () => 0.25);
  const sr = t.sampleRate;
  const grid = windowGrid(sr);
  const windowFrames = Math.max(1, Math.ceil((opts.windowSec ?? 512) / grid)) * grid * sr;
  const warm = Math.ceil((t.tail + SETTLE) / grid) * grid * sr;
  const fade = Math.round(CROSSFADE * sr);
  const count = Math.max(1, Math.ceil(t.length / windowFrames));
  // Progress over everything rendered, warm-ups included.
  const spans: Array<{ out0: number; out1: number; f0: number; f1: number }> = [];
  for (let k = 0; k < count; k++) {
    const out0 = k * windowFrames;
    const out1 = Math.min(t.length, out0 + windowFrames);
    spans.push({ out0, out1, f0: k === 0 ? 0 : Math.max(0, out0 - warm), f1: k === count - 1 ? t.length : Math.min(t.length, out1 + fade) });
  }
  const work = spans.reduce((n, s) => n + (s.f1 - s.f0), 0);
  let done = 0;
  let latency = 0;
  let synced = true;
  /** The previous window's audio past its end: crossfaded into this one's start. */
  let overlap: Float32Array[] | null = null;
  for (const s of spans) {
    opts.signal?.throwIfAborted();
    const r = await renderSpan(project, opts, t, s.f0, s.f1 - s.f0, (f) => opts.onProgress?.(Math.min(1, (done + f) / work)));
    done += s.f1 - s.f0;
    latency = r.latency;
    synced &&= r.synced;
    const data = Array.from({ length: r.buffer.numberOfChannels }, (_, c) => r.buffer.getChannelData(c));
    const base = s.out0 - s.f0;
    if (overlap) {
      const n = overlap[0]?.length ?? 0;
      data.forEach((d, c) => {
        const prev = overlap![c] as Float32Array;
        for (let i = 0; i < n; i++) {
          const a = prev[i] as number;
          const b = d[base + i] as number;
          // a + w·(b − a): exactly a (and b) where both windows agree.
          d[base + i] = a === b ? a : a + ((i + 0.5) / n) * (b - a);
        }
      });
    }
    for (let f = s.out0; f < s.out1; f += sr) {
      const n = Math.min(sr, s.out1 - f);
      opts.signal?.throwIfAborted();
      await opts.onAudio(
        data.map((d) => d.slice(base + f - s.out0, base + f - s.out0 + n)),
        f,
        { preRoll: t.preRoll, latency },
      );
    }
    overlap = s.f1 > s.out1 ? data.map((d) => d.slice(base + (s.out1 - s.out0), base + (s.f1 - s.out0))) : null;
  }
  opts.onProgress?.(1);
  return { preRoll: t.preRoll, latency, synced, frames: t.length, sampleRate: sr, windows: count };
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
    // Only the plugins: the probe plays nothing, so it doesn't decode the song's audio.
    await probe.pluginsReady();
    return probe.tailSeconds();
  } finally {
    await probe.dispose();
  }
}
