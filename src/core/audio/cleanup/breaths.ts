/**
 * Finding the breaths in a vocal recording and turning them down. A breath is a stretch of sound that is
 *   - noisy rather than pitched (the pitch tracker finds no voice in it, and its spectrum is flat, not a comb of
 *     harmonics),
 *   - well above the room noise (or there is nothing to turn down), and
 *   - well below the singing (a loud hiss at the level of the vowels is an "s" or "f", which must stay),
 * and lasts longer than a consonant (about 0.15 s or more). Pure and deterministic (no DOM, no random).
 */
import { hannWindow, nextPowerOfTwo, RealFFT } from '../../voice/fft';
import { trackPitch } from '../../voice/pitch';
import type { BreathSpan } from '../../model/types';

/** Seconds between the analysis frames. */
const HOP_SECONDS = 0.01;
/** Seconds of sound in each analysis frame (rounded to a power of two in samples). */
const FRAME_SECONDS = 0.02;
/** The band the spectrum's flatness is measured in, Hz. */
const FLATNESS_LOW_HZ = 300;
const FLATNESS_HIGH_HZ = 8000;
/** A frame with at least this spectral flatness (geometric ÷ arithmetic mean of the power, 0–1) is noise. Harmonic voices score below 0.05, white noise about 0.56. */
const MIN_FLATNESS = 0.2;
/** A frame the pitch tracker finds a voice in with at least this confidence is voiced (0–1). */
const VOICED_CONFIDENCE = 0.55;
/** The range of fundamentals the pitch tracker looks for a voice in, Hz. */
const VOICE_MIN_HZ = 70;
const VOICE_MAX_HZ = 1000;
/** Frames this far (seconds) from a voiced frame are not breath: the voice's own tail and onset noise. */
const VOICE_GUARD_SECONDS = 0.02;
/** A breath must be this many dB above the quiet floor (the 10th-percentile frame level). */
const MIN_ABOVE_FLOOR_DB = 6;
/** Gaps up to this long between noisy frames do not split a breath (seconds). */
const BRIDGE_SECONDS = 0.04;
/** Shortest and longest breath (seconds); sensitivity moves the shortest between these. */
const SHORTEST_SECONDS = [0.2, 0.1] as const;
const LONGEST_SECONDS = 1.8;
/** A breath's median level must be this far below the singing's median (dB): at sensitivity 0 and at 1. */
const BELOW_SINGING_DB = [22, 10] as const;
/** Seconds of the fade into and out of a lowered breath, inside its edges (so a neighbour's voice is never touched). */
export const BREATH_FADE_SECONDS = 0.02;
/** Turning a breath down by this much or more removes it completely. */
export const BREATH_REMOVE_DB = 60;

const lerp = (pair: readonly [number, number], t: number): number => pair[0] + (pair[1] - pair[0]) * t;

/** Per-frame measurements of a recording (hop `HOP_SECONDS`): level in dB, flatness 0–1, voiced flag. */
interface Frames {
  levelDb: Float32Array;
  flatness: Float32Array;
  voiced: Uint8Array;
}

/** Measures every frame of `mono`. */
function measureFrames(mono: Float32Array, sampleRate: number): Frames {
  const hop = Math.round(HOP_SECONDS * sampleRate);
  const size = nextPowerOfTwo(Math.round(FRAME_SECONDS * sampleRate));
  const count = Math.max(0, Math.floor((mono.length - size) / hop) + 1);
  const levelDb = new Float32Array(count);
  const flatness = new Float32Array(count);
  const fft = new RealFFT(size);
  const window = hannWindow(size);
  const re = new Float64Array(fft.bins);
  const im = new Float64Array(fft.bins);
  const binHz = sampleRate / size;
  const low = Math.max(1, Math.ceil(FLATNESS_LOW_HZ / binHz));
  const high = Math.min(fft.bins - 1, Math.floor(FLATNESS_HIGH_HZ / binHz));
  for (let m = 0; m < count; m++) {
    const at = m * hop;
    let energy = 0;
    for (let i = 0; i < size; i++) {
      const v = mono[at + i] as number;
      energy += v * v;
      fft.frame[i] = v * (window[i] as number);
    }
    levelDb[m] = 10 * Math.log10(energy / size + 1e-14);
    fft.forward(fft.frame, re, im);
    let logSum = 0;
    let sum = 0;
    for (let k = low; k <= high; k++) {
      const p = (re[k] as number) ** 2 + (im[k] as number) ** 2 + 1e-18;
      logSum += Math.log(p);
      sum += p;
    }
    const n = high - low + 1;
    flatness[m] = n > 0 ? Math.exp(logSum / n) / (sum / n) : 0;
  }
  return { levelDb, flatness, voiced: voicedFrames(mono, sampleRate, count, hop, size) };
}

/** Which analysis frames have a voice in them, from the YIN pitch track (its frames are 5 ms apart). */
function voicedFrames(mono: Float32Array, sampleRate: number, count: number, hop: number, size: number): Uint8Array {
  const voiced = new Uint8Array(count);
  const track = trackPitch(mono, sampleRate, { minHz: VOICE_MIN_HZ, maxHz: VOICE_MAX_HZ });
  // The tracker's frames are this many samples apart (its default hop, a rounded 5 ms).
  const trackHop = track.times.length > 1 ? (track.times[1] as number) * sampleRate : 1;
  for (let m = 0; m < count; m++) {
    // The tracker's frames inside this analysis frame's middle half.
    const from = Math.floor((m * hop + size * 0.25) / trackHop);
    const to = Math.ceil((m * hop + size * 0.75) / trackHop);
    for (let i = Math.max(0, from); i <= Math.min(track.f0.length - 1, to); i++) {
      if ((track.f0[i] as number) > 0 && (track.confidence[i] as number) >= VOICED_CONFIDENCE) {
        voiced[m] = 1;
        break;
      }
    }
  }
  return voiced;
}

/** The p-th percentile (0–1) of `values`. */
function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number) : 0;
}

/**
 * The breaths in `mono`, in seconds, in time order. `sensitivity` 0–1: higher finds shorter and louder breaths too
 * (default 0.5). A recording with no singing in it (nothing to compare to) has none.
 */
export function detectBreaths(mono: Float32Array, sampleRate: number, sensitivity = 0.5): BreathSpan[] {
  const frames = measureFrames(mono, sampleRate);
  const count = frames.levelDb.length;
  if (count === 0) return [];
  const voicedLevels: number[] = [];
  for (let m = 0; m < count; m++) if (frames.voiced[m]) voicedLevels.push(frames.levelDb[m] as number);
  if (voicedLevels.length < 5) return [];
  const singingDb = percentile(voicedLevels, 0.5);
  const floorDb = percentile(frames.levelDb, 0.1);
  const t = Math.min(1, Math.max(0, sensitivity));
  const ceilingDb = singingDb - lerp(BELOW_SINGING_DB, t);
  const guard = Math.round(VOICE_GUARD_SECONDS / HOP_SECONDS);

  // Frames that look like breath: noisy, unvoiced (and not next to voice), above the floor, below the singing.
  const breathy = new Uint8Array(count);
  for (let m = 0; m < count; m++) {
    const level = frames.levelDb[m] as number;
    if (frames.voiced[m] || (frames.flatness[m] as number) < MIN_FLATNESS) continue;
    if (level < floorDb + MIN_ABOVE_FLOOR_DB || level > ceilingDb + 6) continue;
    breathy[m] = 1;
  }
  const candidates = groupFrames(breathy, Math.round(BRIDGE_SECONDS / HOP_SECONDS));
  const spans: BreathSpan[] = [];
  for (const run of candidates) {
    const length = (run.to - run.from + 1) * HOP_SECONDS;
    if (length < lerp(SHORTEST_SECONDS, t) || length > LONGEST_SECONDS) continue;
    if (touchesVoice(frames.voiced, run.from, run.to, guard)) {
      // A breath may end right where the voice starts, but a short noisy sound hugging a vowel is a consonant.
      if (length < SHORTEST_SECONDS[0] * 1.5) continue;
    }
    const middle = percentile(frames.levelDb.subarray(run.from, run.to + 1), 0.5);
    if (middle > ceilingDb) continue;
    // The analysis frame is centred FRAME_SECONDS / 2 after its start.
    const offset = FRAME_SECONDS / 2;
    spans.push({ from: Math.max(0, run.from * HOP_SECONDS + offset - HOP_SECONDS / 2), to: Math.min(mono.length / sampleRate, (run.to + 1) * HOP_SECONDS + offset - HOP_SECONDS / 2) });
  }
  return spans;
}

/** Runs of consecutive 1s in `flags` (gaps of up to `bridge` frames are filled), as inclusive frame ranges. */
function groupFrames(flags: Uint8Array, bridge: number): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let m = 0;
  while (m < flags.length) {
    if (!flags[m]) {
      m++;
      continue;
    }
    let to = m;
    let gap = 0;
    let probe = m + 1;
    while (probe < flags.length && gap <= bridge) {
      if (flags[probe]) {
        to = probe;
        gap = 0;
      } else gap++;
      probe++;
    }
    runs.push({ from: m, to });
    m = to + 1;
  }
  return runs;
}

/** True when a voiced frame lies within `guard` frames before `from` or after `to`. */
function touchesVoice(voiced: Uint8Array, from: number, to: number, guard: number): boolean {
  for (let m = Math.max(0, from - guard); m < from; m++) if (voiced[m]) return true;
  for (let m = to + 1; m <= Math.min(voiced.length - 1, to + guard); m++) if (voiced[m]) return true;
  return false;
}

/**
 * Turns the breaths down: `reduceDb` (0 = untouched, `BREATH_REMOVE_DB` or more = silence) inside every span that
 * is not switched off, with a raised-cosine fade of `BREATH_FADE_SECONDS` inside each edge so nothing clicks.
 * Works in place on every channel.
 */
export function lowerBreaths(
  channels: readonly Float32Array[],
  sampleRate: number,
  spans: readonly BreathSpan[],
  reduceDb: number,
): void {
  if (reduceDb <= 0) return;
  const target = reduceDb >= BREATH_REMOVE_DB ? 0 : Math.pow(10, -reduceDb / 20);
  for (const span of spans) {
    if (span.off) continue;
    const length = channels[0]?.length ?? 0;
    const from = Math.max(0, Math.round(span.from * sampleRate));
    const to = Math.min(length, Math.round(span.to * sampleRate));
    const fade = Math.min(Math.round(BREATH_FADE_SECONDS * sampleRate), Math.floor((to - from) / 2));
    for (const channel of channels) {
      for (let i = from; i < to; i++) {
        const inFade = Math.min(i - from, to - 1 - i);
        const weight = inFade >= fade ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * (inFade + 0.5)) / fade);
        channel[i] = (channel[i] as number) * (1 + (target - 1) * weight);
      }
    }
  }
}
