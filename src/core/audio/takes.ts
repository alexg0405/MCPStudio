/**
 * Where recorded audio goes on the playlist. While recording, the recorder notes "anchors": a frame
 * of the capture and the song tick the performer heard when they played it (the capture's clock
 * minus the round-trip latency, through the transport, so tempo changes and loop wraps count). From
 * those, each loop pass becomes a take: a clip at the pass's start, trimmed into the one recording
 * at the frame where that pass began (cut to the punch range, when there is one). Pure, unit-tested in Node.
 *
 * Latency: music scheduled at context time τ leaves the speakers at τ + delay compensation + output
 * latency; a performer playing along is recorded at that plus the input latency. So a frame captured
 * at context time F belongs to the music scheduled at F − (output + input latency) − delay
 * compensation: `engine.tickAt(F − roundTrip)` (tickAt takes the delay compensation off itself).
 */
import type { Tick } from '../model/types';
import type { TempoMap } from '../time/ppq';

export interface CaptureAnchor {
  /** Frames into the capture. */
  frame: number;
  /** The song tick heard when that frame was played (latency compensated). */
  tick: number;
  /** Loop pass it belongs to (the transport's loop iteration). */
  iter: number;
}

export interface TakePlan {
  /** 0 = the first pass. */
  pass: number;
  /** Where the clip goes (song ticks) and how far into the recording it starts (seconds). */
  start: Tick;
  length: Tick;
  offsetSec: number;
  /** It covers the whole loop region. */
  complete: boolean;
}

export interface TakeInput {
  anchors: readonly CaptureAnchor[];
  sampleRate: number;
  /** Frames captured. */
  frames: number;
  tempo: TempoMap;
  /** The loop region passes wrap at, or null. */
  loop: { start: Tick; end: Tick } | null;
  /** Punch in and out: only this part of every pass is kept (a pass is cut to it). */
  punch?: { start: Tick; end: Tick } | null;
  /** Where playback started. */
  startTick: Tick;
  /** The tick heard when recording stopped (default: where the last captured frame is). */
  endTick?: number;
  /** Passes shorter than this are dropped (default 120 ticks, a 1/32 note). */
  minTicks?: number;
}

/** The capture frame at which `tick` was heard in a pass, from the pass's nearest anchor. */
export function frameAtTick(anchors: readonly CaptureAnchor[], tempo: TempoMap, sampleRate: number, tick: number): number {
  let best = anchors[0] as CaptureAnchor;
  for (const a of anchors) if (Math.abs(a.tick - tick) < Math.abs(best.tick - tick)) best = a;
  return best.frame + (tempo.tickToSeconds(tick) - tempo.tickToSeconds(best.tick)) * sampleRate;
}

/** The tick heard at a capture frame in a pass, from the pass's nearest anchor. */
export function tickAtFrame(anchors: readonly CaptureAnchor[], tempo: TempoMap, sampleRate: number, frame: number): number {
  let best = anchors[0] as CaptureAnchor;
  for (const a of anchors) if (Math.abs(a.frame - frame) < Math.abs(best.frame - frame)) best = a;
  return tempo.secondsToTick(tempo.tickToSeconds(best.tick) + (frame - best.frame) / sampleRate);
}

/** One take per loop pass (a single one without a loop region), in pass order. */
export function planTakes(input: TakeInput): TakePlan[] {
  const { anchors, sampleRate: sr, tempo, loop } = input;
  if (anchors.length === 0 || input.frames <= 0) return [];
  const minTicks = input.minTicks ?? 120;
  const L = loop && loop.end > loop.start ? loop : null;
  const P = input.punch && input.punch.end > input.punch.start ? input.punch : null;
  /** What a complete pass covers: the loop region, cut to the punch range. */
  const region = L ? { start: Math.max(L.start, P?.start ?? 0), end: Math.min(L.end, P?.end ?? Infinity) } : null;
  const byPass = new Map<number, CaptureAnchor[]>();
  for (const a of anchors) {
    const list = byPass.get(a.iter);
    if (list) list.push(a);
    else byPass.set(a.iter, [a]);
  }
  const passes = [...byPass.keys()].sort((a, b) => a - b);
  const first = passes[0] as number;
  const last = passes[passes.length - 1] as number;
  const out: TakePlan[] = [];
  for (const pass of passes) {
    const list = byPass.get(pass) as CaptureAnchor[];
    // Playback starting outside the loop region jumps into it.
    let start =
      pass === first
        ? L && (input.startTick < L.start || input.startTick >= L.end)
          ? L.start
          : input.startTick
        : (L?.start ?? input.startTick);
    let end: number;
    if (pass !== last && L) end = L.end;
    else {
      const lastFrame = tickAtFrame(list, tempo, sr, input.frames);
      end = Math.min(lastFrame, input.endTick ?? Infinity);
      if (L) end = Math.min(end, L.end);
    }
    if (P) {
      start = Math.max(start, P.start);
      end = Math.min(end, P.end);
    }
    let frame = frameAtTick(list, tempo, sr, start);
    if (frame < 0) {
      // The capture began after the pass did (no count-in, slow start): the take starts with it.
      start = tickAtFrame(list, tempo, sr, 0);
      frame = 0;
    }
    const s = Math.round(start);
    const length = Math.round(end) - s;
    if (length < minTicks) continue;
    out.push({
      pass: pass - first,
      start: s,
      length,
      offsetSec: Math.max(0, frame / sr + (tempo.tickToSeconds(s) - tempo.tickToSeconds(start))),
      complete: !!region && region.end > region.start && s <= region.start && s + length >= region.end,
    });
  }
  return out;
}

/** Which takes play: the newest complete pass (or the newest one, when none is complete). */
export function audibleTake(takes: readonly TakePlan[]): number {
  for (let i = takes.length - 1; i >= 0; i--) if ((takes[i] as TakePlan).complete) return i;
  return takes.length - 1;
}

/**
 * A punch recording keeps only what the takes play, with a handle either side (to reveal a little more
 * by dragging a clip's edge, and for crossfades): the frames to keep and the takes with their trims moved
 * to match. Frames are capped to the capture.
 */
export function trimToTakes(
  takes: readonly TakePlan[],
  tempo: TempoMap,
  sampleRate: number,
  frames: number,
  handleSec = 1,
): { from: number; to: number; takes: TakePlan[] } {
  if (takes.length === 0) return { from: 0, to: frames, takes: [] };
  let lo = Infinity;
  let hi = 0;
  for (const t of takes) {
    const dur = tempo.tickToSeconds(t.start + t.length) - tempo.tickToSeconds(t.start);
    lo = Math.min(lo, t.offsetSec);
    hi = Math.max(hi, t.offsetSec + dur);
  }
  const from = Math.max(0, Math.floor((lo - handleSec) * sampleRate));
  const to = Math.min(frames, Math.ceil((hi + handleSec) * sampleRate));
  return { from, to, takes: takes.map((t) => ({ ...t, offsetSec: Math.max(0, t.offsetSec - from / sampleRate) })) };
}
