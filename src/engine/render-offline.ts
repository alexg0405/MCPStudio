import type { Project } from '@core/model/types';
import type { EngineOptions, TransportView } from './api';
import { tempoMapOf } from '@core/automation/tempo';
import { ticksPerBar, type TempoMap } from '@core/time/ppq';
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

/** Frames of one render quantum: the finest timing the audio thread has. */
const RENDER_QUANTUM = 128;
/** Frames rendered per chunk when the caller gives no size: while suspended between chunks the clips are made ready. */
const DEFAULT_CHUNK_FRAMES = RENDER_QUANTUM * 256;
/** The sample rate of a render that does not ask for one. */
const DEFAULT_SAMPLE_RATE = 48000;
/** The tail after the last bar of a render that does not ask for one (seconds). */
const DEFAULT_TAIL_SEC = 1;
/** Pre-roll of a one-piece render (frames): silence before the first note, so processors exist before it. */
const ONE_PIECE_PRE_ROLL_FRAMES = 2048;
/** Pre-roll of a streamed render (seconds). */
const STREAM_PRE_ROLL_SEC = 0.25;
/** How far past the chunk's end the transport plans (seconds), and how far ahead the samples are made ready. */
const PLAN_AHEAD_SEC = 0.05;
/** The music ends this far (seconds) before the end of the render span, so a note ending right there is released in it. */
const END_SLACK_SEC = 1e-6;
/** Seconds of output per render window of a streamed render, when the caller gives none. */
const DEFAULT_WINDOW_SEC = 512;
/** Output is handed to the caller in pieces of at most this many seconds. */
const PIECE_SEC = 1;

async function timingOf(project: Project, opts: RenderOptions, defaultPreRoll: (sr: number) => number): Promise<Timing> {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const ts = project.transport.timeSig;
  const preRoll = opts.preRoll ?? defaultPreRoll(sampleRate);
  // The rendered span follows the tempo map (tempo automation in song mode).
  const from = opts.fromTick ?? 0;
  const tempo = tempoMapOf(project, opts.view.mode);
  const musical = tempo.tickToSeconds(from + opts.bars * ticksPerBar(ts)) - tempo.tickToSeconds(from);
  const tail = opts.tail === 'auto' ? await measureTail(project, opts, sampleRate) : (opts.tail ?? DEFAULT_TAIL_SEC);
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
  const { sampleRate, preRoll } = t;
  const chunk = opts.chunk ?? DEFAULT_CHUNK_FRAMES;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const engine = new Engine(ctx, opts, true, { limiter: opts.limiter ?? true });
  const tempo = tempoMapOf(project, opts.view.mode);
  try {
    const offset = startFrame / sampleRate;
    const end = preRoll + t.musical - offset - END_SLACK_SEC;
    let synced = true;
    const { startTick, startAt } = transportStart(t, tempo, offset);
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
      const horizon = Math.min(end, next / sampleRate + PLAN_AHEAD_SEC);
      if (end > 0) {
        await engine.prepareOffline(horizon + PLAN_AHEAD_SEC);
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
    // The first stop comes one quantum in: processors exist by then and the pre-roll covers it.
    void ctx.suspend(RENDER_QUANTUM / sampleRate).then(() => step(RENDER_QUANTUM));
    const buffer = await Promise.race([ctx.startRendering(), rejectWhenAborted(opts.signal)]);
    onProgress(length);
    return { buffer, preRoll, synced, latency: engine.graphLatency() };
  } finally {
    await engine.dispose();
  }
}

/** Where the transport starts: the song tick at context time 0 (or the pre-roll in the first window), and when. */
function transportStart(t: Timing, tempo: TempoMap, offsetSec: number): { startTick: number; startAt: number } {
  const startSec = Math.max(0, offsetSec - t.preRoll);
  const startTick = startSec > 0 ? tempo.secondsToTick(tempo.tickToSeconds(t.from) + startSec) : t.from;
  const startAt = startSec > 0 ? t.preRoll + startSec - offsetSec : t.preRoll;
  return { startTick, startAt };
}

/** A promise that never resolves and rejects when the signal aborts (immediately if it already has). */
function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (!signal) return;
    const fail = () => reject(signal.reason ?? new DOMException('Rendering was cancelled.', 'AbortError'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/**
 * Renders with an OfflineAudioContext using the same engine code as playback, in one piece (the
 * whole render is in memory: use renderStream for long songs).
 */
export async function renderOffline(project: Project, opts: RenderOptions): Promise<RenderResult> {
  const t = await timingOf(project, opts, (sampleRate) => ONE_PIECE_PRE_ROLL_FRAMES / sampleRate);
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
const CROSSFADE_SEC = 0.1;
/** Seconds of warm-up beyond the effects' tails (delays and filters settle completely). */
const SETTLE_SEC = 8;

/** One render window: the output frames it delivers, and the frames it renders (a warm-up before, a crossfade after). */
interface WindowSpan {
  outStart: number;
  outEnd: number;
  renderStart: number;
  renderEnd: number;
}

/** Splits the render into windows of `windowFrames`, each starting early by `warmFrames` and running on by `fadeFrames`. */
function planWindows(totalFrames: number, windowFrames: number, warmFrames: number, fadeFrames: number): WindowSpan[] {
  const count = Math.max(1, Math.ceil(totalFrames / windowFrames));
  const spans: WindowSpan[] = [];
  for (let k = 0; k < count; k++) {
    const outStart = k * windowFrames;
    const outEnd = Math.min(totalFrames, outStart + windowFrames);
    spans.push({
      outStart,
      outEnd,
      renderStart: k === 0 ? 0 : Math.max(0, outStart - warmFrames),
      renderEnd: k === count - 1 ? totalFrames : Math.min(totalFrames, outEnd + fadeFrames),
    });
  }
  return spans;
}

/** Crossfades the previous window's audio past its end (`overlap`) into the start of this one's output, in place. */
function crossfadeInto(data: Float32Array[], base: number, overlap: Float32Array[]): void {
  const frames = overlap[0]?.length ?? 0;
  data.forEach((channelData, c) => {
    const previous = overlap[c] as Float32Array;
    for (let i = 0; i < frames; i++) {
      const a = previous[i] as number;
      const b = channelData[base + i] as number;
      // a + w·(b − a): exactly a (and b) where both windows agree.
      channelData[base + i] = a === b ? a : a + ((i + 0.5) / frames) * (b - a);
    }
  });
}

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
  const t = await timingOf(project, opts, () => STREAM_PRE_ROLL_SEC);
  const sampleRate = t.sampleRate;
  const grid = windowGrid(sampleRate);
  const windowFrames = Math.max(1, Math.ceil((opts.windowSec ?? DEFAULT_WINDOW_SEC) / grid)) * grid * sampleRate;
  const warmFrames = Math.ceil((t.tail + SETTLE_SEC) / grid) * grid * sampleRate;
  const fadeFrames = Math.round(CROSSFADE_SEC * sampleRate);
  const spans = planWindows(t.length, windowFrames, warmFrames, fadeFrames);
  // Progress over everything rendered, warm-ups included.
  const work = spans.reduce((total, span) => total + (span.renderEnd - span.renderStart), 0);
  let done = 0;
  let latency = 0;
  let synced = true;
  /** The previous window's audio past its end: crossfaded into this one's start. */
  let overlap: Float32Array[] | null = null;
  for (const span of spans) {
    opts.signal?.throwIfAborted();
    const frames = span.renderEnd - span.renderStart;
    const rendered = await renderSpan(project, opts, t, span.renderStart, frames, (f) =>
      opts.onProgress?.(Math.min(1, (done + f) / work)),
    );
    done += frames;
    latency = rendered.latency;
    synced &&= rendered.synced;
    const data = Array.from({ length: rendered.buffer.numberOfChannels }, (_, c) => rendered.buffer.getChannelData(c));
    // Where this window's own output starts in what was rendered (after its warm-up).
    const base = span.outStart - span.renderStart;
    if (overlap) crossfadeInto(data, base, overlap);
    await deliver(opts, data, base, span, sampleRate, t.preRoll, latency);
    overlap =
      span.renderEnd > span.outEnd
        ? data.map((d) => d.slice(base + (span.outEnd - span.outStart), base + (span.renderEnd - span.outStart)))
        : null;
  }
  opts.onProgress?.(1);
  return { preRoll: t.preRoll, latency, synced, frames: t.length, sampleRate, windows: spans.length };
}

/** Hands the window's output to the caller in pieces of at most PIECE_SEC, in order. */
async function deliver(
  opts: StreamRenderOptions,
  data: Float32Array[],
  base: number,
  span: WindowSpan,
  sampleRate: number,
  preRoll: number,
  latency: number,
): Promise<void> {
  const pieceFrames = PIECE_SEC * sampleRate;
  for (let frame = span.outStart; frame < span.outEnd; frame += pieceFrames) {
    const length = Math.min(pieceFrames, span.outEnd - frame);
    opts.signal?.throwIfAborted();
    const from = base + frame - span.outStart;
    await opts.onAudio(
      data.map((channelData) => channelData.slice(from, from + length)),
      frame,
      { preRoll, latency },
    );
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
    // Only the plugins: the probe plays nothing, so it doesn't decode the song's audio. Samples in plugin slots are
    // only measured (their lengths from the headers), so one-shot samplers can report how long a note really sounds.
    await probe.pluginsReady();
    await probe.sampleLengthsReady();
    return probe.tailSeconds();
  } finally {
    await probe.dispose();
  }
}
