/**
 * One track analysis from decoded audio: loudness and true peak on the full-rate channels, then a
 * mono copy at about 22 kHz for the beat, key and structure analysis (`core/dj/analyze`). Worker-safe
 * (no DOM): the analysis Worker runs it, and so does the main thread where there is no Worker.
 */
import { analyzeTrack } from '@core/dj/analyze';
import type { TrackAnalysis } from '@core/dj/types';
import { decimate } from '@core/voice/filters';
import { LoudnessMeter } from '@agstudio/sdk/dsp/loudness';
import { TruePeak } from '@agstudio/sdk/dsp/true-peak';

export interface AnalysisJob {
  hash: string;
  /** One or two channels (more are ignored). */
  channels: Float32Array[];
  sampleRate: number;
}

const BLOCK = 1024;

/** Integrated loudness (LUFS) and true peak (dBTP). True peak is oversampled only near the loudest blocks. */
export function loudness(channels: readonly Float32Array[], sampleRate: number, progress?: (f: number) => void): { lufs: number; truePeakDb: number } {
  const left = channels[0];
  if (!left || left.length === 0) return { lufs: -Infinity, truePeakDb: -Infinity };
  const right = channels[1] ?? left;
  const stereo = channels.length > 1;
  // Sample peak per block, to know where a true peak can be.
  const blocks = Math.ceil(left.length / BLOCK);
  const blockPeak = new Float32Array(blocks);
  let peak = 0;
  for (let b = 0; b < blocks; b++) {
    let m = 0;
    for (let i = b * BLOCK; i < Math.min(left.length, (b + 1) * BLOCK); i++) {
      const l = Math.abs(left[i]!);
      const r = Math.abs(right[i]!);
      if (l > m) m = l;
      if (r > m) m = r;
    }
    blockPeak[b] = m;
    if (m > peak) peak = m;
  }
  // Inter-sample peaks rise at most a few dB above the samples around them.
  const near = peak * 0.5;
  const meter = new LoudnessMeter(sampleRate, stereo ? 2 : 1);
  const tpL = new TruePeak();
  const tpR = new TruePeak();
  let tp = 0;
  const step = Math.max(1, Math.floor(blocks / 10));
  for (let b = 0; b < blocks; b++) {
    const exact = blockPeak[b]! >= near || (blockPeak[b + 1] ?? 0) >= near;
    for (let i = b * BLOCK; i < Math.min(left.length, (b + 1) * BLOCK); i++) {
      const l = left[i]!;
      const r = right[i]!;
      meter.process(l, r);
      const t = exact ? Math.max(tpL.process(l), stereo ? tpR.process(r) : 0) : Math.max(tpL.sample(l), stereo ? tpR.sample(r) : 0);
      if (t > tp) tp = t;
    }
    if (progress && b % step === 0) progress(b / blocks);
  }
  const top = Math.max(tp, peak);
  return { lufs: meter.integrated, truePeakDb: top > 0 ? 20 * Math.log10(top) : -Infinity };
}

/** Mono at about 22 kHz (an integer fraction of the source rate). */
export function analysisSignal(channels: readonly Float32Array[], sampleRate: number): { mono: Float32Array; sampleRate: number } {
  const n = channels[0]?.length ?? 0;
  const use = channels.slice(0, 2);
  const mono = new Float32Array(n);
  for (const c of use) for (let i = 0; i < n; i++) mono[i] = mono[i]! + c[i]!;
  if (use.length > 1) for (let i = 0; i < n; i++) mono[i] = mono[i]! / use.length;
  const factor = Math.max(1, Math.round(sampleRate / 22050));
  return factor > 1 ? { mono: decimate(mono, factor, sampleRate), sampleRate: sampleRate / factor } : { mono, sampleRate };
}

export function runAnalysis(
  job: AnalysisJob,
  opts: { onProgress?(fraction: number): void; isCancelled?(): boolean } = {},
): TrackAnalysis {
  const durationSec = (job.channels[0]?.length ?? 0) / job.sampleRate;
  const { lufs, truePeakDb } = loudness(job.channels, job.sampleRate, (f) => opts.onProgress?.(0.2 * f));
  const signal = analysisSignal(job.channels, job.sampleRate);
  opts.onProgress?.(0.25);
  return analyzeTrack(
    { hash: job.hash, mono: signal.mono, sampleRate: signal.sampleRate, durationSec, lufs, truePeakDb },
    {
      onProgress: (f) => opts.onProgress?.(0.25 + 0.75 * f),
      ...(opts.isCancelled ? { isCancelled: opts.isCancelled } : {}),
    },
  );
}
