/**
 * Where syllables and consonants start in a voice, for "Tighten timing to the grid" and for keeping attacks sharp.
 * The strength of an onset is the spectral flux plus the rise of the loudness over the next few frames; peaks that
 * stand out from their neighbourhood and are far enough apart are onsets, and each is then placed where the sound
 * really begins (the first moment the envelope reaches a fifth of the attack's peak), because the spectrum window
 * sees an attack a few milliseconds before it starts.
 */
import type { FrameFeatures } from './features';

/** Onsets closer together than this (seconds) are one: the stronger stays. */
const MIN_GAP_SEC = 0.09;
/** The loudness rise is measured from this many frames before to this many after. */
const RISE_BEFORE = 1;
const RISE_AFTER = 3;
/** A peak must exceed this share of the strongest onset's strength, and this absolute floor. */
const RELATIVE_FLOOR = 0.12;
const ABSOLUTE_FLOOR = 0.15;
/** The refinement looks this far before and after the peak (seconds); the envelope smooths over `ENVELOPE_SEC`. */
const REFINE_BEFORE_SEC = 0.03;
const REFINE_AFTER_SEC = 0.05;
const ENVELOPE_SEC = 0.0025;
/** The onset is the first moment the envelope reaches this share of the peak of the attack. */
const START_SHARE = 0.2;

/** The onset strength of every frame. */
function onsetStrength(features: FrameFeatures): Float32Array {
  const { frames, loudness, flux } = features;
  const out = new Float32Array(frames);
  for (let k = 0; k < frames; k++) {
    const before = loudness[Math.max(0, k - RISE_BEFORE)] as number;
    const after = loudness[Math.min(frames - 1, k + RISE_AFTER)] as number;
    out[k] = (flux[k] as number) + 2 * Math.max(0, after - before);
  }
  return out;
}

/** Frames that are the largest within ± the gap, above the floors (strongest first, then sorted by time). */
function pickPeaks(strength: Float32Array, hopSec: number): number[] {
  let top = 0;
  for (const v of strength) top = Math.max(top, v);
  const floor = Math.max(ABSOLUTE_FLOOR, RELATIVE_FLOOR * top);
  const radius = Math.max(1, Math.round(MIN_GAP_SEC / hopSec / 2));
  const peaks: number[] = [];
  for (let k = 0; k < strength.length; k++) {
    const v = strength[k] as number;
    if (v < floor) continue;
    let isPeak = true;
    for (let j = Math.max(0, k - radius); j <= Math.min(strength.length - 1, k + radius) && isPeak; j++) {
      const other = strength[j] as number;
      if (other > v || (other === v && j < k)) isPeak = false;
    }
    if (isPeak) peaks.push(k);
  }
  return peaks;
}

/** Where the sound near `aroundSec` begins: the first moment the smoothed envelope reaches a fifth of the attack's peak. */
function refineOnset(mono: Float32Array, sampleRate: number, aroundSec: number): number {
  const from = Math.max(0, Math.floor((aroundSec - REFINE_BEFORE_SEC) * sampleRate));
  const to = Math.min(mono.length, Math.ceil((aroundSec + REFINE_AFTER_SEC) * sampleRate));
  const width = Math.max(1, Math.round(ENVELOPE_SEC * sampleRate));
  if (to - from < 2 * width) return aroundSec;
  const envelope = new Float32Array(to - from);
  let running = 0;
  for (let i = 0; i < to - from; i++) {
    running += Math.abs(mono[from + i] as number);
    if (i >= width) running -= Math.abs(mono[from + i - width] as number);
    envelope[i] = running / width;
  }
  let peak = 0;
  for (const v of envelope) peak = Math.max(peak, v);
  if (peak <= 0) return aroundSec;
  for (let i = 0; i < envelope.length; i++) {
    if ((envelope[i] as number) >= START_SHARE * peak) return (from + i - width / 2) / sampleRate;
  }
  return aroundSec;
}

/** The onsets of a voice (seconds from frame 0, sorted), with the mono it was described from for the fine placement. */
export function syllableOnsets(features: FrameFeatures, mono: Float32Array, sampleRate: number): number[] {
  const strength = onsetStrength(features);
  const peaks = pickPeaks(strength, features.hopSec);
  const refined = peaks.map((k) => refineOnset(mono, sampleRate, k * features.hopSec));
  return refined.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - (all[i - 1] as number) > 0.02);
}
