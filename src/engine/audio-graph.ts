/** `value` limited to [`min`, `max`]; `fallback` (default `min`) when it is not a finite number. */
export function clampOrFallback(value: number, min: number, max: number, fallback = min): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * Moves an AudioParam to `value`: smoothed while the context runs, immediately before it has
 * started (offline renders apply the whole document at time 0, so they are exact and timer-free).
 */
export function glide(param: AudioParam, value: number, ctx: BaseAudioContext, timeConstant: number): void {
  if (ctx.currentTime === 0) {
    param.cancelScheduledValues(0);
    param.setValueAtTime(value, 0);
  } else {
    param.setTargetAtTime(value, ctx.currentTime, timeConstant);
  }
}

/** Disconnects `from` → `to`, whether or not they are connected. */
export function disconnectFrom(from: AudioNode, to: AudioNode | AudioParam): void {
  try {
    from.disconnect(to as AudioNode);
  } catch {
    /* not connected */
  }
}

/** A DelayNode of exactly `frames` frames (Chrome delays by exactly n frames at n / sampleRate). */
export function frameDelay(ctx: BaseAudioContext, frames: number): DelayNode {
  const seconds = frames / ctx.sampleRate;
  // The maximum is a little over the delay so rounding can never push the delay past it.
  return new DelayNode(ctx, { maxDelayTime: seconds + 0.01, delayTime: seconds });
}
