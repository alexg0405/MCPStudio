/**
 * Pitch alignment: pulls the pitch of an aligned voice towards the guide's pitch contour, note by note and as the
 * guide wobbles, with TD-PSOLA (formants stay). A double sung a few cents off, or without the lead's vibrato, comes
 * out following the lead; a harmony sung a third above stays a third above (the interval it sings, in whole
 * semitones, is kept, and only its deviation from that interval is corrected), so this is for tightening, not for
 * turning a harmony into a unison.
 *
 * The strength 0..1 is the share of the deviation that is corrected. Frames where either voice is unvoiced are left
 * alone, as are deviations over 75 cents (the singers are on different notes or the tracker was wrong).
 */
import { psolaShift } from '../psola';
import { monoMix } from '../pitch-edit/render';
import { trackVoicePitch } from '../../voice/pitch-notes';
import { ALIGN_HOP_SEC } from './features';

/** The interval a voice sings against the guide is read as the median over this many seconds either side. */
const INTERVAL_WINDOW_SEC = 0.25;
/** …taken every this many seconds (the interval changes slowly). */
const INTERVAL_STEP_SEC = 0.05;
/** A deviation larger than this (cents) is not corrected. */
const MAX_DEVIATION_CENTS = 75;
/** Gaps of unvoiced frames up to this long (seconds) are bridged by a line between the deviations either side. */
const BRIDGE_SEC = 0.08;
/** The correction glides over about this long (seconds), so it never steps. */
const GLIDE_SEC = 0.03;
/** Largest correction either way (cents). */
const MAX_CORRECTION_CENTS = 100;

const centsOf = (hz: number) => 1200 * Math.log2(hz / 440);

/** Cents the clip is from the guide at each frame (NaN where either is unvoiced). */
function distanceCents(guideF0: Float32Array, clipF0: Float32Array): Float64Array {
  const n = Math.min(guideF0.length, clipF0.length);
  const out = new Float64Array(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    const guide = guideF0[i] as number;
    const clip = clipF0[i] as number;
    if (guide > 0 && clip > 0) out[i] = centsOf(guide) - centsOf(clip);
  }
  return out;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1] as number;
}

/** The whole-semitone interval (cents) the clip sings against the guide at each frame; NaN far from any voiced frame. */
function singingInterval(distance: Float64Array, hopSec: number): Float64Array {
  const n = distance.length;
  const interval = new Float64Array(n).fill(Number.NaN);
  const half = Math.round(INTERVAL_WINDOW_SEC / hopSec);
  const step = Math.max(1, Math.round(INTERVAL_STEP_SEC / hopSec));
  for (let centre = 0; centre < n; centre += step) {
    const window: number[] = [];
    for (let i = Math.max(0, centre - half); i <= Math.min(n - 1, centre + half); i++) {
      if (!Number.isNaN(distance[i] as number)) window.push(distance[i] as number);
    }
    if (window.length === 0) continue;
    const semitones = Math.round(median(window) / 100) * 100;
    interval.fill(semitones, centre, Math.min(n, centre + step));
  }
  return interval;
}

/** Moving average of ±`half` frames (edges held). */
function boxSmooth(x: Float64Array, half: number): Float64Array {
  if (half < 1) return x;
  const n = x.length;
  const out = new Float64Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] as number) + (x[i] as number);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = ((prefix[b] as number) - (prefix[a] as number)) / (b - a);
  }
  return out;
}

/** Fills short unvoiced gaps by a line between the deviations either side, and sets every other gap to 0. */
function bridgeGaps(deviation: Float64Array, hopSec: number): void {
  const n = deviation.length;
  const maxGap = Math.round(BRIDGE_SEC / hopSec);
  let i = 0;
  while (i < n) {
    if (!Number.isNaN(deviation[i] as number)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && Number.isNaN(deviation[j] as number)) j++;
    const before = i > 0 ? (deviation[i - 1] as number) : Number.NaN;
    const after = j < n ? (deviation[j] as number) : Number.NaN;
    const canBridge = j - i <= maxGap && !Number.isNaN(before) && !Number.isNaN(after);
    for (let k = i; k < j; k++) deviation[k] = canBridge ? before + ((after - before) * (k - i + 1)) / (j - i + 1) : 0;
    i = j;
  }
}

/**
 * The correction in cents for every frame (positive raises the clip): `strength` (0..1) of the deviation of the
 * clip's pitch from the guide's, measured from the interval it sings. Both pitch tracks are per frame of `hopSec`.
 */
export function pitchFollowCurve(
  guideF0: Float32Array,
  clipF0: Float32Array,
  strength: number,
  hopSec: number,
): Float32Array {
  const distance = distanceCents(guideF0, clipF0);
  const interval = singingInterval(distance, hopSec);
  const deviation = new Float64Array(distance.length);
  for (let i = 0; i < deviation.length; i++) {
    const d = (distance[i] as number) - (interval[i] as number);
    deviation[i] = Math.abs(d) <= MAX_DEVIATION_CENTS ? d : Number.NaN;
  }
  bridgeGaps(deviation, hopSec);
  const glided = boxSmooth(boxSmooth(deviation, Math.max(1, Math.round(GLIDE_SEC / hopSec / 2))), Math.max(1, Math.round(GLIDE_SEC / hopSec / 2)));
  const out = new Float32Array(glided.length);
  const k = Math.min(1, Math.max(0, strength));
  for (let i = 0; i < out.length; i++) {
    const frameIsVoiced = (clipF0[i] as number) > 0;
    const cents = frameIsVoiced ? (glided[i] as number) * k : 0;
    out[i] = Math.max(-MAX_CORRECTION_CENTS, Math.min(MAX_CORRECTION_CENTS, cents));
  }
  return out;
}

/** The guide's pitch (Hz per frame of the alignment's hop) read at the time of tracker frame i (`hopSec` apart). */
function guideAt(guideF0: Float32Array, hopSec: number): Float32Array {
  const frames = Math.ceil((guideF0.length * ALIGN_HOP_SEC) / hopSec);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const at = Math.round((i * hopSec) / ALIGN_HOP_SEC);
    out[i] = at < guideF0.length ? (guideF0[at] as number) : 0;
  }
  return out;
}

/** The report of a pitch alignment: how far the clip was from the guide (the median of |deviation|, cents). */
export interface PitchFollowStats {
  /** Median |deviation| from the interval the clip sings, before and after (NaN when nothing was voiced in both). */
  medianCentsBefore: number;
  medianCentsAfter: number;
}

/** The median deviation (cents) of a clip's pitch from the guide's, measured from the interval it sings. */
export function medianDeviationCents(guideF0: Float32Array, clipF0: Float32Array, hopSec: number): number {
  const distance = distanceCents(guideF0, clipF0);
  const interval = singingInterval(distance, hopSec);
  const errors: number[] = [];
  for (let i = 0; i < distance.length; i++) {
    const d = (distance[i] as number) - (interval[i] as number);
    if (!Number.isNaN(d)) errors.push(Math.abs(d));
  }
  return errors.length ? median(errors) : Number.NaN;
}

/**
 * Pulls the pitch of the (already time-aligned) clip towards the guide. `guideF0` is the guide's pitch per frame of
 * `ALIGN_HOP_SEC` on the same time axis as the channels. Returns new channels and the report.
 */
export function followGuidePitch(
  channels: readonly Float32Array[],
  sampleRate: number,
  guideF0: Float32Array,
  strength: number,
  onProgress?: (fraction: number) => void,
): { channels: Float32Array[]; stats: PitchFollowStats } {
  const mono = monoMix(channels);
  const voice = trackVoicePitch(mono, sampleRate, { minHz: 65, maxHz: 1100 });
  const guide = guideAt(guideF0, voice.hop);
  const shift = pitchFollowCurve(guide, voice.f0, strength, voice.hop);
  const hop = Math.max(1, Math.round(ALIGN_HOP_SEC * sampleRate));
  const shifted = psolaShift(channels, sampleRate, { f0: voice.f0, shift, hop, t0: 0 }, onProgress ? { onProgress } : {});
  const after = trackVoicePitch(monoMix(shifted), sampleRate, { minHz: 65, maxHz: 1100 });
  return {
    channels: shifted,
    stats: {
      medianCentsBefore: medianDeviationCents(guide, voice.f0, voice.hop),
      medianCentsAfter: medianDeviationCents(guideAt(guideF0, after.hop), after.f0, after.hop),
    },
  };
}
