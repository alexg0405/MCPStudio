/**
 * The loudness report: renders the song (or a range of it) offline through the master chain with the safety limiter,
 * the way an export would sound, and measures it the way the live meters do. Nothing is changed in the project.
 */
import { tempoMapOf } from '@core/automation/tempo';
import { barSpan } from '@core/time/bars';
import { withAdvice, type LoudnessReport, type Moment } from '@core/metering/report';
import type { Tick } from '@core/model/types';
import { songLength } from '@core/query/playlist';
import { ticksPerBar } from '@core/time/ppq';
import { renderOffline } from '@engine/render-offline';
import { LoudnessProbe } from '../analysis/loudness-probe';
import { busiestWindow, type LevelWindow } from '../mix/auto-level';
import type { Services } from '../services';

const SAMPLE_RATE = 48000;
/** Audio handed to the probe between two breaths for the interface (seconds). */
const SECONDS_PER_SLICE = 20;

export interface ReportOptions {
  /** The part to measure, in ticks of the song (default: the whole song). */
  fromTick?: Tick;
  toTick?: Tick;
  signal?: AbortSignal;
  onProgress?(label: string, fraction: number): void;
  /** Resolves when nothing is playing (rendering next to playback makes it choppy). */
  whenQuiet?(): Promise<void>;
}

/** Lets the interface breathe between slices of measuring (not setTimeout: hidden tabs throttle it to a second). */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(0);
  });
}

/** The part to render, as auto-level describes a window, with how to call it in words. */
interface ReportWindow extends LevelWindow {
  what: string;
}

/** What to render: the whole song or the asked range, or the current pattern on a loop when there is no song yet. */
function windowOf(s: Services, opts: ReportOptions): ReportWindow | null {
  const project = s.doc.getState().project;
  const ts = project.transport.timeSig;
  const bar = ticksPerBar(ts);
  const end = songLength(project);
  if (end <= 0) {
    const loop = busiestWindow(project, s.view.getState().currentPatternId);
    return loop ? { ...loop, what: 'your pattern on a loop' } : null;
  }
  const from = Math.max(0, Math.min(opts.fromTick ?? 0, end - bar));
  const to = Math.max(from + bar, Math.min(opts.toTick ?? end, end));
  const wholeSong = from === 0 && to === end;
  return {
    mode: 'song',
    patternId: null,
    fromTick: from,
    bars: (to - from) / bar,
    what: wholeSong ? 'the whole song' : barSpan(from, to, ts),
  };
}

/** Renders and measures. Resolves null when there is nothing to play. */
export async function loudnessReport(s: Services, opts: ReportOptions = {}): Promise<LoudnessReport | null> {
  const window = windowOf(s, opts);
  if (!window) return null;
  const project = s.doc.getState().project;
  const tempo = tempoMapOf(project, window.mode);
  const bar = ticksPerBar(project.transport.timeSig);
  const startSeconds = tempo.tickToSeconds(window.fromTick);
  const seconds = tempo.tickToSeconds(window.fromTick + window.bars * bar) - startSeconds;
  await opts.whenQuiet?.();
  opts.signal?.throwIfAborted();
  if (!opts.whenQuiet) s.engine.stop();
  opts.onProgress?.('Listening to the song', 0);
  const rendered = await renderOffline(project, {
    plugins: s.plugins,
    sampleCache: s.sampleCache,
    view: { mode: window.mode, patternId: window.patternId, loop: null },
    bars: window.bars,
    fromTick: window.fromTick,
    sampleRate: SAMPLE_RATE,
    tail: 0,
    limiter: true,
    onProgress: (fraction) => opts.onProgress?.('Listening to the song', fraction * 0.8),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const first = Math.round((rendered.preRoll + rendered.latency) * SAMPLE_RATE);
  const length = Math.round(seconds * SAMPLE_RATE);
  const left = rendered.buffer.getChannelData(0).subarray(first, first + length);
  const right = rendered.buffer.numberOfChannels > 1 ? rendered.buffer.getChannelData(1).subarray(first, first + length) : left;
  const probe = new LoudnessProbe(SAMPLE_RATE);
  const slice = SECONDS_PER_SLICE * SAMPLE_RATE;
  for (let from = 0; from < left.length; from += slice) {
    probe.push(left, right, from, Math.min(left.length, from + slice));
    opts.onProgress?.('Measuring', 0.8 + (0.2 * from) / Math.max(1, left.length));
    opts.signal?.throwIfAborted();
    await yieldToUi();
  }
  const result = probe.result();
  opts.onProgress?.('Done', 1);
  const moment = (sec: number | null): Moment | null =>
    sec === null ? null : { sec, tick: tempo.secondsToTick(startSeconds + sec) };
  return withAdvice({
    projectId: project.projectId,
    what: window.what,
    seconds: result.seconds,
    fromTick: window.fromTick,
    integrated: result.integrated,
    range: result.range,
    truePeakDb: result.truePeakDb,
    truePeakAt: moment(result.truePeakSec),
    samplePeakDb: result.samplePeakDb,
    maxMomentary: result.maxMomentary,
    maxMomentaryAt: moment(result.maxMomentarySec),
    maxShortTerm: result.maxShortTerm,
    maxShortTermAt: moment(result.maxShortTermSec),
    correlation: result.correlation,
    monoLossDb: result.monoLossDb,
    at: Date.now(),
  });
}
