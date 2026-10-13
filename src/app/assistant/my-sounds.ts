import type { BeatSound } from '@core/beat/spec';
import { encodeWav } from '@core/io/wav';
import type { SampleRef } from '@core/model/types';
import { importSampleBytes } from '../persistence/sample-import';

/**
 * "Use my sounds": the beat plays the user's own beatboxed hits. The clearest kick, snare and hat
 * of a take are cut out of the recording (short fades, normalized) and stored as samples.
 */

export interface HitLike {
  kind: 'kick' | 'snare' | 'hat' | 'tonal';
  /** Seconds from the start of the recording. */
  time: number;
  duration: number;
  strength: number;
  confidence?: number;
}

export type HitKind = 'kick' | 'snare' | 'hat';

const MAX_SECONDS: Record<HitKind, number> = { kick: 0.6, snare: 0.45, hat: 0.25 };

/** The most convincing hit of each kind: loud and confidently classified. */
export function bestHits<E extends HitLike>(events: readonly E[]): Partial<Record<HitKind, E>> {
  const best: Partial<Record<HitKind, E>> = {};
  const score = (e: E) => e.strength * (e.confidence ?? 1);
  for (const e of events) {
    if (e.kind === 'tonal') continue;
    const cur = best[e.kind];
    if (!cur || score(e) > score(cur)) best[e.kind] = e;
  }
  return best;
}

/** Cuts one hit: from just before its onset, at most `maxSec`, with fades, peak-normalized to 0.9. */
export function sliceHit(
  samples: Float32Array,
  sampleRate: number,
  time: number,
  duration: number,
  maxSec: number,
): Float32Array {
  const pre = Math.round(0.004 * sampleRate);
  const from = Math.max(0, Math.round(time * sampleRate) - pre);
  const len = Math.min(
    samples.length - from,
    Math.round(Math.min(Math.max(duration, 0.05), maxSec) * sampleRate) + pre,
  );
  const out = samples.slice(from, from + Math.max(0, len));
  const fadeIn = Math.min(out.length, Math.round(0.002 * sampleRate));
  const fadeOut = Math.min(out.length, Math.round(0.03 * sampleRate));
  for (let i = 0; i < fadeIn; i++) out[i] = (out[i] as number) * (i / fadeIn);
  for (let i = 0; i < fadeOut; i++) {
    const k = out.length - 1 - i;
    out[k] = (out[k] as number) * (i / fadeOut);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 1e-4) for (let i = 0; i < out.length; i++) out[i] = ((out[i] as number) / peak) * 0.9;
  return out;
}

const LABEL: Record<HitKind, string> = { kick: 'Your kick', snare: 'Your snare', hat: 'Your hat' };

/** Stores the take's best hits as samples, keyed by the beat sound they replace. */
export async function importMySounds(take: {
  events: readonly HitLike[];
  audio: { samples: Float32Array; sampleRate: number };
}): Promise<Partial<Record<BeatSound, SampleRef>>> {
  const out: Partial<Record<BeatSound, SampleRef>> = {};
  const { samples, sampleRate } = take.audio;
  for (const [kind, hit] of Object.entries(bestHits(take.events)) as [HitKind, HitLike][]) {
    const slice = sliceHit(samples, sampleRate, hit.time, hit.duration, MAX_SECONDS[kind]);
    if (slice.length < sampleRate * 0.02) continue;
    const bytes = encodeWav([slice], sampleRate, { bitDepth: 24 });
    const ref = await importSampleBytes(bytes, `${LABEL[kind]}.wav`);
    out[kind] = { ...ref, name: LABEL[kind], durationSec: slice.length / sampleRate, sampleRate, channels: 1 };
  }
  // A snare hit also stands in for claps and rims, a hat for open hats.
  if (out.snare) {
    out.clap ??= out.snare;
    out.rim ??= out.snare;
  }
  if (out.hat) out['open-hat'] ??= out.hat;
  return out;
}
