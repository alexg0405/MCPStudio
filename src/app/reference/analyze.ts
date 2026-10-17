/**
 * Analyzing a reference song: the track analysis the DJ mode already has (tempo, key, beat grid, sections,
 * energy, loudness, true peak: `trackAnalyzer(s).analyze`) plus the tonal balance and stereo width measured
 * over the whole song and each section (`spectrum.ts`). The result is only numbers (`ReferenceTrack`); the
 * audio is decoded, measured and dropped.
 */
import { ANALYSIS_VERSION } from '@core/dj/types';
import type { ReferenceTrack, SampleRef } from '@core/model/types';
import { buildReference } from '@core/reference/track';
import { idbGet, idbSet, isIdbAvailable } from '@platform/idb';
import { defaultDecoder, type AnalysisDecoder } from '../dj/analysis-cache';
import { sampleHash, trackAnalyzer } from '../dj/analyzer';
import type { Services } from '../services';
import { measureTone } from './spectrum';

/** Bump when the tonal measurement changes: stored measurements of other versions are measured again. */
export const MEASURE_VERSION = 1;

const keyOf = (hash: string) => `reference-measure:v${MEASURE_VERSION}.${ANALYSIS_VERSION}:${hash}`;

const memory = new Map<string, ReferenceTrack>();

/** The measurement kept for a file (memory first), or null. Synchronous for what is already loaded. */
export function peekReference(hash: string): ReferenceTrack | null {
  return memory.get(hash) ?? null;
}

/** Reads a stored measurement into memory (the Studio's actions look at `peekReference`). */
export async function loadReference(hash: string): Promise<ReferenceTrack | null> {
  const hit = memory.get(hash);
  if (hit) return hit;
  if (!isIdbAvailable()) return null;
  try {
    const v = await idbGet<ReferenceTrack>(keyOf(hash));
    if (v && v.hash === hash && v.version === ANALYSIS_VERSION && Array.isArray(v.bands)) {
      memory.set(hash, v);
      return v;
    }
  } catch {
    /* nothing stored */
  }
  return null;
}

function remember(track: ReferenceTrack): void {
  memory.set(track.hash, track);
  if (isIdbAvailable()) void idbSet(keyOf(track.hash), track).catch(() => {});
}

/** Forgets every measurement kept in memory (tests). */
export function forgetReferences(): void {
  memory.clear();
}

export interface ReferenceAnalysisOptions {
  signal?: AbortSignal;
  onProgress?(label: string, fraction: number): void;
  /** Where the audio comes from (default: the sample store, or the engine's copy of a built-in). */
  decode?: AnalysisDecoder;
}

/**
 * The measurements of a sample: from the cache, else the track analysis (tempo, key, sections…) and the
 * tonal measurement. Rejects when the song can't be read or the signal aborts.
 */
export async function analyzeReference(s: Services, ref: SampleRef, title: string, opts: ReferenceAnalysisOptions = {}): Promise<ReferenceTrack> {
  const hash = sampleHash(ref);
  if (!hash) throw new Error('The reference needs a song file (a music file you added), not a built-in sound.');
  const cached = (await loadReference(hash)) ?? null;
  const done = (t: ReferenceTrack): ReferenceTrack => ({ ...t, title, sampleId: ref.id });
  if (cached) return done(cached);
  const analyzer = trackAnalyzer(s);
  if (!analyzer) throw new Error('This build has no song analyzer.');
  const report = (label: string, f: number) => opts.onProgress?.(label, f);
  report('Finding the tempo, key and sections', 0);
  const analysis = await analyzer.analyze(s, ref, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    onProgress: (p) => report('Finding the tempo, key and sections', p.fraction * 0.55),
  });
  opts.signal?.throwIfAborted();
  report('Measuring the tonal balance', 0.55);
  const audio = await (opts.decode ?? defaultDecoder)(s, ref);
  if (!audio || (audio.channels[0]?.length ?? 0) === 0) throw new Error(`“${ref.name}” couldn’t be decoded to measure its tonal balance.`);
  const left = audio.channels[0]!;
  const right = audio.channels[1] ?? left;
  const tone = await measureTone(left, right, audio.sampleRate, analysis.sections.map((x) => ({ start: x.start, end: x.end })), {
    ...(opts.signal ? { signal: opts.signal } : {}),
    onProgress: (f) => report('Measuring the tonal balance', 0.55 + 0.45 * f),
  });
  const track = buildReference(analysis, tone, { title, sampleId: ref.id });
  const kept: ReferenceTrack = { ...track, title: '' };
  delete kept.sampleId;
  remember(kept);
  report('Done', 1);
  return track;
}
