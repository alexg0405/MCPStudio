/**
 * Voice analysis: a recording of mouth sounds (beatboxing, humming a bass line) in, timed and
 * classified events out. Pure TypeScript, no DOM.
 *
 * Pipeline (all thresholds are in `VOICE_THRESHOLDS`; each step is a file in `analysis/`):
 *   (analysis/envelopes.ts and band-energy.ts: step 1; flux.ts, onsets.ts, attack.ts: steps 2 and 3;
 *   features.ts: step 4; pitch-frames.ts: the pitch track; classify.ts: step 5; tonal.ts: step 6;
 *   analysis.ts runs them in order.)
 *   1. High-pass at 30 Hz (DC, rumble). Envelopes on 1 ms blocks in three bands (full, < 300 Hz,
 *      > 3 kHz): 11 ms RMS for levels, rises and decay, 3 ms RMS for onset times. The noise floor is
 *      the 10th percentile of the level, capped 25 dB under the loudest moment (so continuous
 *      humming still has a floor under it).
 *   2. Onset candidates: spectral flux of log-compressed band magnitudes (knee just above the noise
 *      floor; ~21 ms Hann frames at 100 frames/s, each compared with the frame 20 ms back;
 *      quarter-octave bands from 30 Hz to 16 kHz), adaptive threshold = moving median × 1.5 +
 *      offset, local-maximum peak picking.
 *   3. Each candidate is checked on the envelopes. Its level must have risen by a few dB (valley →
 *      peak) in the full band, or by more in a sub-band that holds a real share of the sound (a hat
 *      over a kick's tail rises only above 3 kHz). Borderline rises get a second look: after a low
 *      note the level is measured over two pitch periods (it ripples at that rate), after noise the
 *      valley is the median rather than the minimum (noise wobbles). Then gates: the peak must clear
 *      the noise floor and lie within a range under the loudest sound, and a noisy sound that takes
 *      over 40 ms to reach half its level is a swell (a breath), not an attack. The onset time is
 *      where the attack, on the 3 ms envelope of the band that rose most, passes 5 % of the way from
 *      the valley to the peak. Onsets closer than `minGapSec` collapse into one.
 *   4. Per event: peak level, decay (−30 dB from the peak or 6 dB over the noise floor, held 10 ms),
 *      sustain (time above −15 dB), and features from the first 60 ms under an attack-weighted
 *      window, with the background just before the onset (noise, the previous sound's tail)
 *      subtracted per band: power-weighted spectral centroid, energy ratios below 150 Hz and above
 *      4 kHz, zero-crossing rate, and YIN periodicity (on audio decimated to ~8 kHz).
 *   5. Classification: tonal needs periodicity, sustain, confidently pitched frames, little energy
 *      above 4 kHz and no kick-like pitch drop at the start; otherwise kick / snare / hat from soft
 *      (logistic) scores on centroid, the energy ratios and length.
 *   6. Tonal events: onsets inside a sustained tonal event without a real level rise merge away,
 *      then the pitch track splits notes where the pitch moves > 1.5 semitones and stays there
 *      ≥ 60 ms. A glide that never settles stays one event; `pitchEnd` tells where it went.
 */
import { Analysis } from './analysis/analysis';
import type { AnalyzeOptions, VoiceEvent } from './analysis/types';

export { VOICE_THRESHOLDS } from './analysis/thresholds';
export type { AnalyzeOptions, VoiceEvent, VoiceFeatures, VoiceKind, VoiceMode } from './analysis/types';

/** Analyses mouth sounds into events; see the module comment for the pipeline. */
export function analyzeVoice(samples: Float32Array, sampleRate: number, options: AnalyzeOptions = {}): VoiceEvent[] {
  if (!Number.isFinite(sampleRate) || sampleRate < 4000 || samples.length < 2) return [];
  return new Analysis(samples, sampleRate, options).run();
}
