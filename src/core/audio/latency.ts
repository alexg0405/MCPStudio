/**
 * "Calibrate latency": clicks are played at known context times and recorded back through the
 * microphone (or a cable from the output to the input); the delay of each click is the round trip
 * the recorder must compensate. Pure, unit-tested in Node.
 */

export interface LatencyMeasurement {
  /** Median round trip, milliseconds. */
  ms: number;
  /** Largest minus smallest of the clicks found, milliseconds (how steady it is). */
  spreadMs: number;
  /** Clicks heard, of those played. */
  found: number;
  played: number;
}

/**
 * Finds each click of `clickTimes` (context seconds) in a capture that started at `startTime`:
 * the first sample clearly above the noise in the half second after it was played.
 */
export function measureRoundTrip(
  channels: readonly Float32Array[],
  sampleRate: number,
  startTime: number,
  clickTimes: readonly number[],
  opts: { maxSeconds?: number } = {},
): LatencyMeasurement {
  const x = channels[0];
  const delays: number[] = [];
  const maxLag = Math.round((opts.maxSeconds ?? 0.5) * sampleRate);
  if (x && x.length > 0) {
    for (const t of clickTimes) {
      const at = Math.round((t - startTime) * sampleRate);
      if (at < 0 || at >= x.length) continue;
      const end = Math.min(x.length, at + maxLag);
      // Noise floor: the 50 ms before the click went out.
      let noise = 0;
      for (let i = Math.max(0, at - Math.round(0.05 * sampleRate)); i < at; i++) noise = Math.max(noise, Math.abs(level(channels, i)));
      let peak = 0;
      for (let i = at; i < end; i++) peak = Math.max(peak, Math.abs(level(channels, i)));
      if (peak < 0.005 || peak < 4 * noise) continue;
      const threshold = Math.max(3 * noise, 0.25 * peak);
      for (let i = at; i < end; i++)
        if (Math.abs(level(channels, i)) >= threshold) {
          delays.push((i - at) / sampleRate);
          break;
        }
    }
  }
  if (delays.length === 0) return { ms: NaN, spreadMs: NaN, found: 0, played: clickTimes.length };
  const sorted = [...delays].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] as number;
  return {
    ms: Math.round(median * 10000) / 10,
    spreadMs: Math.round(((sorted[sorted.length - 1] as number) - (sorted[0] as number)) * 10000) / 10,
    found: delays.length,
    played: clickTimes.length,
  };
}

function level(channels: readonly Float32Array[], i: number): number {
  let v = 0;
  for (const c of channels) {
    const s = c[i] as number;
    if (Math.abs(s) > Math.abs(v)) v = s;
  }
  return v;
}

/** Whether a measurement can be trusted: most clicks heard, within a few milliseconds of each other. */
export function measurementOk(m: LatencyMeasurement): boolean {
  return m.found >= Math.max(3, Math.ceil(m.played * 0.6)) && m.spreadMs <= 8 && Number.isFinite(m.ms);
}
