/**
 * Mouth clicks: the wet "tk" and lip smacks between words. A click is a very short, very sharp event, a few
 * milliseconds at most, that stands far above the sound around it. Plosive bursts and consonants are longer, and
 * the sharp edge of every glottal pulse in a voice repeats at the pitch period, so neither is mistaken for one.
 * Pure and deterministic (no DOM, no random).
 *
 * Finding: the second difference of the sound (a high-pass that makes a click's edge stand out) is compared with its
 * own average over the 30 ms around; a sample many times above it is a click candidate; the candidate's extent is where
 * the sharp sound stays above the background (at most a few milliseconds each way). Three candidates evenly spaced
 * a pitch period apart are the voice's own pulses and are dropped.
 *
 * Repairing: the sound on each side continues through the gap and the two continuations are crossfaded. In a voiced
 * stretch the continuation repeats the last period (the pitch period is found by autocorrelation); elsewhere it is
 * linear prediction (order 24), so noise and breath stay smooth instead of being bridged by a straight line.
 */

/** A stretch of samples [from, to) of a signal. */
export interface SampleSpan {
  from: number;
  to: number;
}

/** A click candidate must exceed the local average of the sharp sound by this factor: at sensitivity 0 and at 1. */
const THRESHOLD_FACTOR = [10, 5] as const;
/** Seconds each side of a sample the local average is taken over. */
const BASELINE_SECONDS = 0.015;
/** The click's extent: its sharp sound counts until it falls below this factor times the local average. */
const EXTENT_FACTOR = 3;
/** Longest click, seconds; a longer disturbance is a consonant, not a click. */
const LONGEST_SECONDS = 0.007;
/** Most the extent grows each side of the peak, seconds. */
const REACH_SECONDS = 0.003;
/** Extra seconds repaired before and after the found extent (the click's edges and its ringing fade into the background). */
const MARGIN_BEFORE_SECONDS = 0.0003;
const MARGIN_AFTER_SECONDS = 0.0008;
/** Candidates closer than this (seconds) are one click. */
const MERGE_SECONDS = 0.001;
/** The shortest and longest period (seconds) at which evenly spaced candidates are taken for a voice's pulses. */
const PULSE_PERIOD_SECONDS = [0.0025, 0.014] as const;
/** Linear-prediction order and the seconds of sound on each side the repair learns from (the voiced repair needs two periods). */
const PREDICTION_ORDER = 24;
const CONTEXT_SECONDS = 0.03;
/** The periods (seconds) a voice is looked for in around a click, and how alike a period and the one before it must be (0–1) to repeat it. */
const VOICE_PERIOD_SECONDS = [0.0025, 0.0125] as const;
const MIN_PERIODICITY = 0.6;
/** Seconds of sound at the gap's edge the voice period is measured over. */
const PERIOD_WINDOW_SECONDS = 0.015;
/** Part of the signal's power added to the autocorrelation's first lag (white-noise correction) so the filter stays stable. */
const REGULARIZATION = 1e-6;

const lerp = (pair: readonly [number, number], t: number): number => pair[0] + (pair[1] - pair[0]) * t;

/** The clicks in `mono` (sensitivity 0–1, default 0.5: higher finds smaller clicks), as sample ranges in time order. */
export function detectClicks(mono: Float32Array, sampleRate: number, sensitivity = 0.5): SampleSpan[] {
  const n = mono.length;
  if (n < 8) return [];
  const sharp = new Float32Array(n);
  for (let i = 2; i < n; i++) sharp[i] = Math.abs((mono[i] as number) - 2 * (mono[i - 1] as number) + (mono[i - 2] as number));
  const average = movingAverage(sharp, Math.round(BASELINE_SECONDS * sampleRate));
  const factor = lerp(THRESHOLD_FACTOR, Math.min(1, Math.max(0, sensitivity)));
  const candidates = findCandidates(sharp, average, factor, sampleRate);
  const clicks = dropVoicePulses(candidates, sampleRate);
  return clicks
    .map((c) => extentOf(sharp, average, c.peak, sampleRate))
    .filter((e): e is SampleSpan => e !== null)
    .reduce(mergeSpans(Math.round(MERGE_SECONDS * sampleRate)), []);
}

/** Average of `values` over `radius` samples each side (shorter at the ends), by running sums. */
function movingAverage(values: Float32Array, radius: number): Float32Array {
  const n = values.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] as number) + (values[i] as number);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    out[i] = ((prefix[hi] as number) - (prefix[lo] as number)) / (hi - lo) + 1e-9;
  }
  return out;
}

/** A sample far above its surroundings: where. */
interface Candidate {
  peak: number;
}

/** The loudest sample of every group of samples above `factor` times their local average (groups closer than a millisecond are one). */
function findCandidates(sharp: Float32Array, average: Float32Array, factor: number, sampleRate: number): Candidate[] {
  const groupGap = Math.round(MERGE_SECONDS * sampleRate);
  const found: Candidate[] = [];
  let best = -1;
  let last = -Infinity;
  for (let i = 0; i < sharp.length; i++) {
    if ((sharp[i] as number) <= factor * (average[i] as number)) continue;
    if (i - last > groupGap && best >= 0) {
      found.push({ peak: best });
      best = -1;
    }
    if (best < 0 || (sharp[i] as number) > (sharp[best] as number)) best = i;
    last = i;
  }
  if (best >= 0) found.push({ peak: best });
  return found;
}

/** Removes candidates that sit three in a row a voice period apart (a vowel's glottal pulses). */
function dropVoicePulses(candidates: readonly Candidate[], sampleRate: number): Candidate[] {
  const minGap = PULSE_PERIOD_SECONDS[0] * sampleRate;
  const maxGap = PULSE_PERIOD_SECONDS[1] * sampleRate;
  const periodic = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const gap = (candidates[j] as Candidate).peak - (candidates[i] as Candidate).peak;
      if (gap > maxGap) break;
      if (gap < minGap) continue;
      for (let k = j + 1; k < candidates.length; k++) {
        const next = (candidates[k] as Candidate).peak - (candidates[j] as Candidate).peak;
        if (next > gap * 1.1) break;
        if (next >= gap * 0.9) [i, j, k].forEach((x) => periodic.add(x));
      }
    }
  }
  return candidates.filter((_, i) => !periodic.has(i));
}

/** How far the click around `peak` reaches: where its sharp sound sinks back to the background (null when it goes on too long). */
function extentOf(sharp: Float32Array, average: Float32Array, peak: number, sampleRate: number): SampleSpan | null {
  const reach = Math.round(REACH_SECONDS * sampleRate);
  const gap = Math.max(2, Math.round(0.0002 * sampleRate));
  const above = (i: number): boolean => (sharp[i] as number) > EXTENT_FACTOR * (average[i] as number);
  const walk = (step: 1 | -1): number => {
    let edge = peak;
    let quiet = 0;
    for (let i = peak + step; i >= 0 && i < sharp.length && Math.abs(i - peak) <= reach; i += step) {
      if (above(i)) {
        edge = i;
        quiet = 0;
      } else if (++quiet > gap) break;
    }
    return edge;
  };
  const from = Math.max(0, walk(-1) - 2 - Math.round(MARGIN_BEFORE_SECONDS * sampleRate));
  const to = Math.min(sharp.length, walk(1) + 1 + Math.round(MARGIN_AFTER_SECONDS * sampleRate));
  return to - from > LONGEST_SECONDS * sampleRate ? null : { from, to };
}

/** A reducer that joins spans closer than `gap` samples. */
function mergeSpans(gap: number): (spans: SampleSpan[], next: SampleSpan) => SampleSpan[] {
  return (spans, next) => {
    const last = spans[spans.length - 1];
    if (last && next.from - last.to <= gap) last.to = Math.max(last.to, next.to);
    else spans.push({ ...next });
    return spans;
  };
}

/** Linear-prediction coefficients a[1..order] (Levinson-Durbin) of a windowed stretch: x[n] ≈ −Σ a[k]·x[n−k]. Null when it has no energy. */
function predictionFilter(x: Float64Array, order: number): Float64Array | null {
  const n = x.length;
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += (x[i] as number) * (x[i - lag] as number);
    r[lag] = sum;
  }
  if ((r[0] as number) < 1e-12) return null;
  r[0] = (r[0] as number) * (1 + REGULARIZATION);
  const a = new Float64Array(order + 1);
  const scratch = new Float64Array(order + 1);
  a[0] = 1;
  let error = r[0] as number;
  for (let m = 1; m <= order; m++) {
    let acc = r[m] as number;
    for (let k = 1; k < m; k++) acc += (a[k] as number) * (r[m - k] as number);
    const reflection = -acc / error;
    scratch.set(a);
    for (let k = 1; k < m; k++) a[k] = (scratch[k] as number) + reflection * (scratch[m - k] as number);
    a[m] = reflection;
    error *= 1 - reflection * reflection;
    if (error <= 0) break;
  }
  return a;
}

/** Predicts `count` samples after `context` (the last samples of it are the most recent) into `out`. */
function extrapolate(context: Float64Array, a: Float64Array, count: number, out: Float64Array): void {
  const order = a.length - 1;
  const history = new Float64Array(order + count);
  const start = Math.max(0, context.length - order);
  const have = context.length - start;
  for (let i = 0; i < have; i++) history[order - have + i] = context[start + i] as number;
  for (let i = 0; i < count; i++) {
    let v = 0;
    for (let k = 1; k <= order; k++) v -= (a[k] as number) * (history[order + i - k] as number);
    history[order + i] = v;
    out[i] = v;
  }
}

/** The voice period in samples at the end of `approaching` (the sound as it nears the gap), or 0 when it is not voiced there. */
function voicePeriod(approaching: Float64Array, sampleRate: number): number {
  const shortest = Math.round(VOICE_PERIOD_SECONDS[0] * sampleRate);
  const longest = Math.round(VOICE_PERIOD_SECONDS[1] * sampleRate);
  const n = approaching.length;
  const window = Math.min(n - longest, Math.round(PERIOD_WINDOW_SECONDS * sampleRate));
  if (window < longest) return 0;
  let best = 0;
  let bestScore = MIN_PERIODICITY;
  for (let lag = shortest; lag <= longest; lag++) {
    let cross = 0;
    let now = 0;
    let before = 0;
    for (let i = n - window; i < n; i++) {
      const current = approaching[i] as number;
      const earlier = approaching[i - lag] as number;
      cross += current * earlier;
      now += current * current;
      before += earlier * earlier;
    }
    const score = cross / Math.sqrt(now * before + 1e-30);
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  return best;
}

/** Continues `approaching` for `count` samples by repeating its last `period` samples. */
function repeatPeriod(approaching: Float64Array, period: number, count: number, out: Float64Array): void {
  const n = approaching.length;
  for (let i = 0; i < count; i++) out[i] = i < period ? (approaching[n - period + i] as number) : (out[i - period] as number);
}

/** The samples of `x` in [from, to) in the order they approach the gap: as they are, or reversed so the gap is after the last one. */
function approachingGap(x: Float32Array, from: number, to: number, reverse: boolean): Float64Array {
  const length = to - from;
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = x[reverse ? to - 1 - i : from + i] as number;
  return out;
}

/** A copy fading to nothing at the far end (the part nearest the gap is kept): what the prediction filter is learned from. */
function taperedAwayFromGap(approaching: Float64Array): Float64Array {
  const length = approaching.length;
  return approaching.map((v, i) => v * (0.5 + 0.5 * Math.cos((Math.PI * (length - 1 - i)) / length)));
}

/** How the sound continues from one side into a gap of `count` samples: its period repeated when voiced, else linear prediction. Null when there is nothing to go on. */
function continuation(approaching: Float64Array, count: number, sampleRate: number): Float64Array | null {
  if (approaching.length < PREDICTION_ORDER * 2) return null;
  const out = new Float64Array(count);
  const period = voicePeriod(approaching, sampleRate);
  if (period > 0) {
    repeatPeriod(approaching, period, count, out);
    return out;
  }
  const filter = predictionFilter(taperedAwayFromGap(approaching), PREDICTION_ORDER);
  if (!filter) return null;
  extrapolate(approaching, filter, count, out);
  return out;
}

/**
 * Repairs `spans` of `channel` in place. A span with too little sound on a side (the start of the file) is replaced
 * by a straight line between its two ends instead.
 */
export function repairClicks(channel: Float32Array, sampleRate: number, spans: readonly SampleSpan[]): void {
  const context = Math.round(CONTEXT_SECONDS * sampleRate);
  for (const span of spans) {
    const length = span.to - span.from;
    if (length <= 0) continue;
    const before = approachingGap(channel, Math.max(0, span.from - context), span.from, false);
    const after = approachingGap(channel, span.to, Math.min(channel.length, span.to + context), true);
    const ahead = continuation(before, length, sampleRate);
    const behind = continuation(after, length, sampleRate);
    if (!ahead || !behind) {
      straightLine(channel, span);
      continue;
    }
    for (let i = 0; i < length; i++) {
      const weight = (i + 0.5) / length;
      channel[span.from + i] = (1 - weight) * (ahead[i] as number) + weight * (behind[length - 1 - i] as number);
    }
  }
}

/** Replaces the span with a straight line between the samples next to it. */
function straightLine(channel: Float32Array, span: SampleSpan): void {
  const left = channel[Math.max(0, span.from - 1)] as number;
  const right = channel[Math.min(channel.length - 1, span.to)] as number;
  const length = span.to - span.from;
  for (let i = 0; i < length; i++) channel[span.from + i] = left + ((right - left) * (i + 1)) / (length + 1);
}
