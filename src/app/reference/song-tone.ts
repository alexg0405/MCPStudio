/**
 * Listening to the musician's own song the way the reference was measured: renders the busiest part of
 * the mix (through the master's effects, limiter on: what is heard) and measures its loudness, true peak,
 * tonal balance in the same eight bands and stereo width.
 */
import { tempoMapOf } from '@core/automation/tempo';
import { ticksPerBar } from '@core/time/ppq';
import { renderOffline } from '@engine/render-offline';
import { Measurer } from '../analysis/measure';
import { busiestWindow } from '../mix/auto-level';
import type { Services } from '../services';
import { measureTone } from './spectrum';

export interface SongTone {
  /** Share of the energy per band in dB under the total (`TONE_BANDS`). */
  bands: number[];
  width: number;
  lufs: number;
  truePeakDb: number | null;
  /** The part that was listened to: "bars 17–24". */
  what: string;
  /** Which project it was (the project id), and when. */
  projectId: string;
  at: number;
}

export interface SongToneOptions {
  signal?: AbortSignal;
  onProgress?(label: string, fraction: number): void;
  sampleRate?: number;
  /** Resolves when nothing is playing (rendering next to playback makes it choppy). */
  whenQuiet?(): Promise<void>;
}

const RATE = 48000;

/** Renders and measures the busiest part of the song. Resolves null when nothing plays. */
export async function measureSongTone(s: Services, opts: SongToneOptions = {}): Promise<SongTone | null> {
  const rate = opts.sampleRate ?? RATE;
  const project = s.doc.getState().project;
  const window = busiestWindow(project, s.view.getState().currentPatternId);
  if (!window) return null;
  const bar = ticksPerBar(project.transport.timeSig);
  const toTick = window.fromTick + window.bars * bar;
  const tempo = tempoMapOf(project, window.mode);
  const seconds = tempo.tickToSeconds(toTick) - tempo.tickToSeconds(window.fromTick);
  const frames = Math.round(seconds * rate);
  await opts.whenQuiet?.();
  opts.signal?.throwIfAborted();
  if (!opts.whenQuiet) s.engine.stop();
  opts.onProgress?.('Listening to your mix', 0);
  const r = await renderOffline(project, {
    plugins: s.plugins,
    sampleCache: s.sampleCache,
    view: { mode: window.mode, patternId: window.patternId, loop: null },
    bars: window.bars,
    fromTick: window.fromTick,
    sampleRate: rate,
    tail: 0,
    limiter: true,
    onProgress: (f) => opts.onProgress?.('Listening to your mix', f * 0.7),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const start = Math.round((r.preRoll + r.latency) * rate);
  const left = r.buffer.getChannelData(0).subarray(start, start + frames);
  const right = r.buffer.numberOfChannels > 1 ? r.buffer.getChannelData(1).subarray(start, start + frames) : left;
  opts.onProgress?.('Measuring your mix', 0.7);
  const m = new Measurer(rate, true);
  for (let i = 0; i < left.length; i += rate) {
    m.push(left, right, i, Math.min(left.length, i + rate));
    opts.signal?.throwIfAborted();
  }
  const loud = m.result();
  if (loud.silent) return null;
  const tone = await measureTone(left, right, rate, [], opts.signal ? { signal: opts.signal } : {});
  opts.onProgress?.('Done', 1);
  const first = Math.floor(window.fromTick / bar) + 1;
  return {
    bands: tone.bands,
    width: tone.width,
    lufs: loud.lufs,
    truePeakDb: loud.truePeakDb,
    what: window.mode === 'pattern' ? 'your pattern on a loop' : `bars ${first}–${first + window.bars - 1}`,
    projectId: project.projectId,
    at: Date.now(),
  };
}
