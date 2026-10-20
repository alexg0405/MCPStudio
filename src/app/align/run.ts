/**
 * One alignment job as plain data in, plain data out: what the Worker runs (and what runs on the calling thread in Node
 * tests). The job carries audio already cut to the stretch to render and the guide on the same time axis (`guide-audio.ts`).
 */
import {
  alignToGuide,
  tightenToGrid,
  warpKnots,
  type AlignStats,
  type AudibleSpan,
} from '@core/audio/align';
import { nearestLine } from '@core/audio/align/plan';

/** Aligns the clip's sound to a guide voice. */
export interface GuideJob {
  kind: 'guide';
  channels: Float32Array[];
  sampleRate: number;
  /** Seconds on the clip's sample where `channels` begin. */
  startSec: number;
  audible: AudibleSpan;
  guide: { mono: Float32Array; sampleRate: number; audible: AudibleSpan };
  tightness: number;
  pitch: number;
}

/** Tightens the clip's syllable onsets towards the grid. */
export interface GridJob {
  kind: 'grid';
  channels: Float32Array[];
  sampleRate: number;
  startSec: number;
  audible: AudibleSpan;
  /** Grid lines in seconds from the start of `channels`. */
  linesSec: number[];
  strength: number;
  maxMoveSec: number;
}

export type AlignJob = GuideJob | GridJob;

/** What a job returns. */
export interface AlignJobResult {
  channels: Float32Array[];
  /** The overlay points (`warpKnots`). */
  warp: number[];
  stats: AlignStats;
}

/** Runs a job. Deterministic. */
export function runAlignJob(job: AlignJob, onProgress?: (fraction: number) => void): AlignJobResult {
  const progress = onProgress ? { onProgress } : {};
  const out =
    job.kind === 'guide'
      ? alignToGuide({
          channels: job.channels,
          sampleRate: job.sampleRate,
          audible: job.audible,
          guide: job.guide,
          tightness: job.tightness,
          pitch: job.pitch,
          ...progress,
        })
      : tightenToGrid({
          channels: job.channels,
          sampleRate: job.sampleRate,
          audible: job.audible,
          nearestGridSec: nearestLine(job.linesSec),
          strength: job.strength,
          maxMoveSec: job.maxMoveSec,
          ...progress,
        });
  return { channels: out.channels, warp: warpKnots(out.lagSec, out.hopSec, job.startSec), stats: out.stats };
}
