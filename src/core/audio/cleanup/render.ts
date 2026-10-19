/**
 * Carrying a vocal cleanup out: what the settings mean for the sound of a whole sample. Pure functions of plain data
 * (no DOM, no globals), so the Worker, the app and the tests all agree. The order inside the cleanup is
 *   1. mouth clicks (sharp events are repaired before anything smears them),
 *   2. noise reduction (a spectral gate learned from a quiet stretch),
 *   3. breaths (a gain envelope on the spans found in the original recording, with short fades).
 * The result has the same length and timeline as the input, so trims, fades and tempo follow keep working.
 */
import type { BreathSpan, VocalCleanup } from '../../model/types';
import { detectBreaths, lowerBreaths } from './breaths';
import { detectClicks, repairClicks } from './clicks';
import { AUTO_NOISE_SECONDS, findQuietStretch, learnNoiseProfile, MIN_NOISE_SECONDS, monoOf, type Stretch } from './noise-profile';
import { denoiseChannels } from './spectral-denoise';

/** What looking at a sample found, to be written into the settings so the same render can be made again. */
export interface CleanupFindings {
  /** The quiet stretch the noise is learned from (seconds), found automatically or the one that was set. Absent when there is none. */
  noise?: Stretch;
  /** Why noise reduction could not run, in plain words. */
  noiseProblem?: string;
  /** The breaths (all of them, switched-off ones included). Absent when breath control is off. */
  breaths?: BreathSpan[];
  /** The sample positions of the clicks repaired. */
  clickCount: number;
}

/** The cleaned sound and what the render found. */
export interface CleanupResult {
  channels: Float32Array[];
  findings: CleanupFindings;
}

/** The input of a render. */
export interface CleanupJob {
  channels: readonly Float32Array[];
  sampleRate: number;
  settings: VocalCleanup;
  /** Called now and then with 0..1. */
  onProgress?: (fraction: number) => void;
}

/** Parts of the progress each step takes. */
const PROGRESS_CLICKS = 0.05;
const PROGRESS_NOISE_END = 0.95;

/**
 * Looks at the sample for what the settings leave open: the quiet stretch (when the noise section has none) and the
 * breaths (when the breath section has none). Everything already in the settings is kept as it is.
 */
export function analyzeCleanup(channels: readonly Float32Array[], sampleRate: number, settings: VocalCleanup): CleanupFindings {
  const mono = monoOf(channels);
  const findings: CleanupFindings = { clickCount: 0 };
  const noise = settings.noise;
  if (noise && noise.amountDb > 0) {
    const set = noise.from !== undefined && noise.to !== undefined ? { from: noise.from, to: noise.to } : null;
    const stretch = set ?? findQuietStretch(mono, sampleRate, AUTO_NOISE_SECONDS);
    if (stretch && stretch.to - stretch.from >= MIN_NOISE_SECONDS) findings.noise = stretch;
    else findings.noiseProblem = 'No quiet stretch was found to learn the noise from: choose a part of the clip with only the room sound in it.';
  }
  const breaths = settings.breaths;
  if (breaths && breaths.reduceDb > 0) findings.breaths = breaths.spans ?? detectBreaths(mono, sampleRate, breaths.sensitivity);
  return findings;
}

/** Makes the cleaned sound (a copy; the input is not touched). Findings missing from the settings are made first (see `analyzeCleanup`). */
export function renderCleanup(job: CleanupJob): CleanupResult {
  const { sampleRate, settings, onProgress } = job;
  const findings = analyzeCleanup(job.channels, sampleRate, settings);
  let channels: Float32Array[] = job.channels.map((c) => Float32Array.from(c));

  if (settings.clicks) findings.clickCount = removeClicks(channels, sampleRate, settings.clicks.sensitivity);
  onProgress?.(PROGRESS_CLICKS);

  const noise = settings.noise;
  if (noise && noise.amountDb > 0 && findings.noise) {
    const profile = learnNoiseProfile(monoOf(channels), sampleRate, findings.noise.from, findings.noise.to);
    if (profile) {
      channels = denoiseChannels(channels, sampleRate, profile, { amountDb: noise.amountDb, sensitivity: noise.sensitivity }, {
        onProgress: (f) => onProgress?.(PROGRESS_CLICKS + f * (PROGRESS_NOISE_END - PROGRESS_CLICKS)),
      });
    } else {
      findings.noiseProblem = 'The stretch chosen for the noise is silent or too short: choose a part of the clip with only the room sound in it.';
      delete findings.noise;
    }
  }

  const breaths = settings.breaths;
  if (breaths && breaths.reduceDb > 0 && findings.breaths) lowerBreaths(channels, sampleRate, findings.breaths, breaths.reduceDb);
  onProgress?.(1);
  return { channels, findings };
}

/** Finds the clicks in the mix of the channels and repairs every channel there. Returns how many were repaired. */
function removeClicks(channels: Float32Array[], sampleRate: number, sensitivity: number): number {
  const spans = detectClicks(monoOf(channels), sampleRate, sensitivity);
  for (const channel of channels) repairClicks(channel, sampleRate, spans);
  return spans.length;
}

/**
 * What the cleanup took out: the input minus the output, channel by channel ("hear the noise only"). Shorter or longer
 * channels than the input's are cut to the input's length.
 */
export function removedSound(input: readonly Float32Array[], cleaned: readonly Float32Array[]): Float32Array[] {
  return input.map((channel, c) => {
    const out = new Float32Array(channel.length);
    const other = cleaned[c] ?? channel;
    for (let i = 0; i < out.length; i++) out[i] = (channel[i] as number) - (other[i] as number);
    return out;
  });
}
