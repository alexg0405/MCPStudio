import { AudibleClock } from './audible-clock';
import { isRealtimeContext } from './realtime-context';

/** How far past the output's last timestamp the heard time may run on the wall clock (seconds). */
const MAX_EXTRAPOLATION_SEC = 0.1;
/** How long (ms) one reading of the output clock answers every reader (a frame is 16 ms). */
const AUDIBLE_CACHE_MS = 2;

/** The audio callback's period assumed where the context reports none (offline renders, tests). */
const FALLBACK_BASE_LATENCY_SEC = 0.01;

/** The start lead never goes below this (seconds): the message to the audio thread needs about a render quantum. */
const MIN_START_LEAD_SEC = 0.012;
/** ...and never above this: a start this far ahead would feel late. */
const MAX_START_LEAD_SEC = 0.05;
/** A fixed part of the start lead (seconds): one render quantum and some slack. */
const START_LEAD_FIXED_SEC = 0.006;
/** How many audio callbacks (`baseLatency`) the message with the first notes may need to be handled. */
const START_LEAD_CALLBACKS = 1.5;
/** What the start lead learns to add after a start whose first notes went out late (seconds). */
const START_PAD_STEP_SEC = 0.01;
/** The most the start lead learns to add (seconds). */
const MAX_START_PAD_SEC = 0.03;

/** A live note's release waits at least this long after its press (seconds), whatever the buffer size. */
const MIN_PREVIEW_HOLD_SEC = 0.01;
/** ...and at least this many audio callbacks (`baseLatency`): the sound has started a callback and a bit after the press. */
const PREVIEW_HOLD_CALLBACKS = 2.5;

/**
 * How the audio context's clock relates to what comes out of the speakers, and how far ahead of "now" a start must be
 * scheduled so the first notes arrive in time.
 */
export class OutputClock {
  /** Smooths the heard time so the playhead moves evenly (and never back): see audible-clock.ts. */
  private readonly smoother = new AudibleClock();
  /** The `performance.now()` of the last answer of `audibleTime()`, and that answer. */
  private lastReadAtMs = Number.NEGATIVE_INFINITY;
  private lastReadValue = 0;
  /** Extra start lead learned from late starts (seconds). */
  private startPad = 0;

  constructor(private readonly ctx: BaseAudioContext) {}

  /**
   * Context time currently coming out of the speakers: the output's last timestamp, carried on by
   * the wall clock for at most `MAX_EXTRAPOLATION_SEC` (when the audio thread falls behind, its clock
   * stalls; running on past it and snapping back made the playhead jump back and forth), then smoothed
   * and kept from going back (`AudibleClock`).
   */
  audibleTime(): number {
    const ctx = this.ctx;
    if (!isRealtimeContext(ctx)) return ctx.currentTime;
    // Everything that reads it within a frame (playhead, step lights, automation, tempo readouts: several per
    // frame) gets one answer: a clock read allocates a timestamp object, and readers must agree on the time.
    const nowMs = performance.now();
    if (nowMs - this.lastReadAtMs < AUDIBLE_CACHE_MS && nowMs >= this.lastReadAtMs) return this.lastReadValue;
    const rawTime = this.rawAudibleTime(ctx);
    this.lastReadAtMs = nowMs;
    this.lastReadValue = this.smoother.step(rawTime, nowMs);
    return this.lastReadValue;
  }

  /** The audible time from the output's timestamp, or from the context's own clock minus its latencies when it has none yet. */
  private rawAudibleTime(ctx: AudioContext): number {
    const stamp = ctx.getOutputTimestamp();
    if (stamp.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0) {
      const sinceStampSec = (performance.now() - stamp.performanceTime) / 1000;
      const extrapolatedSec = Math.max(0, Math.min(MAX_EXTRAPOLATION_SEC, sinceStampSec));
      return stamp.contextTime + extrapolatedSec;
    }
    return ctx.currentTime - (ctx.outputLatency || 0) - ctx.baseLatency;
  }

  /** The context time that was coming out of the speakers at a `performance.now()` timestamp (MIDI events carry one). */
  contextTimeAt(performanceMs: number): number {
    const ctx = this.ctx;
    if (!isRealtimeContext(ctx)) return ctx.currentTime;
    const stamp = ctx.getOutputTimestamp();
    if (stamp.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0) {
      return stamp.contextTime + (performanceMs - stamp.performanceTime) / 1000;
    }
    return ctx.currentTime - (ctx.outputLatency || 0) - ctx.baseLatency + (performanceMs - performance.now()) / 1000;
  }

  /** The audio callback's period (seconds), or a typical one where the context reports none. */
  private baseLatency(): number {
    return isRealtimeContext(this.ctx) ? this.ctx.baseLatency : FALLBACK_BASE_LATENCY_SEC;
  }

  /**
   * Seconds between pressing play (or seeking) and the first beat. The first notes reach the audio thread by message,
   * which handles them within about one audio callback (`baseLatency`) plus a render quantum; anything earlier is
   * wasted waiting. Measured with the output probe in test/browser/latency.test.ts: 14 / 21 / 38 ms for the small,
   * medium and large buffer, where the fixed 50 ms it replaced added a third to a half of the response. The pad grows
   * by 10 ms (to 30) every time notes still went out late (`learnFromLateStart`), and stays.
   */
  startLead(): number {
    const wanted = START_LEAD_FIXED_SEC + START_LEAD_CALLBACKS * this.baseLatency() + this.startPad;
    return Math.min(MAX_START_LEAD_SEC, Math.max(MIN_START_LEAD_SEC, wanted));
  }

  /** The first notes of a start went out late (a busy main thread): leave more room next time. */
  learnFromLateStart(): void {
    this.startPad = Math.min(MAX_START_PAD_SEC, this.startPad + START_PAD_STEP_SEC);
  }

  /**
   * How long a live note's release is held back after its press (seconds). `currentTime` only moves once per audio
   * callback (21 ms with the large buffer), so a quick tap's release could carry the very time of the press and
   * cancel the note (a release at or before its start): it waits until the sound has started.
   */
  previewHold(): number {
    return Math.max(MIN_PREVIEW_HOLD_SEC, PREVIEW_HOLD_CALLBACKS * this.baseLatency());
  }
}
