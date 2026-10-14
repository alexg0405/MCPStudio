import { produce } from 'immer';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { KIT_VERSION } from '@core/model/kit';
import type { ChannelId, NoteId, PatternId, Project, SampleId, SampleRef } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { addNote } from '@core/ops/notes';
import { renderOffline } from '@engine/render-offline';
import { defaultValues, type ParamValue, type PluginDef } from '@agstudio/sdk';
import { resolver } from './fixtures';

// Instrument tests: one channel playing notes through the real engine, offline (browser tests only).

export const SR = 48000;
/** renderOffline's default pre-roll and the master limiter's look-ahead, in frames. */
export const PRE_ROLL = 2048;
export const LIMITER_DELAY = Math.round(0.0013 * SR);
/** The frame where the music starts in a render at SR. */
export const START = PRE_ROLL + LIMITER_DELAY;

export interface TestNote {
  /** Start in beats (quarter notes) from the start of the pattern. */
  at: number;
  /** Length in beats. */
  len: number;
  key: number;
  velocity?: number;
  pan?: number;
  fine?: number;
}

export interface InstrumentRender {
  params?: Record<string, ParamValue>;
  /** Kit sounds by sample slot (e.g. { pad1: 'kit/kick' }), or full sample refs. */
  samples?: Record<string, string | SampleRef>;
  bpm?: number;
  /** Bars of pattern to render (the pattern is this long, so it never loops early). */
  bars?: number;
  /** Seconds rendered after the last bar. */
  tail?: number;
  sampleRate?: number;
  chunk?: number;
}

export function kitRef(generator: string, id = `smp_${generator.replace(/\W/g, '')}`): SampleRef {
  return { id: id as SampleId, name: generator, source: { kind: 'builtin', generator, version: KIT_VERSION } };
}

/** A project with one channel of `def` playing `notes` in the first pattern. */
export function instrumentProject(
  def: PluginDef,
  notes: readonly TestNote[],
  opts: InstrumentRender = {},
): { project: Project; patternId: PatternId; channelId: ChannelId } {
  let project = createEmptyProject();
  const patternId = project.patternOrder[0] as PatternId;
  const refs = Object.entries(opts.samples ?? {}).map(
    ([slot, s]) => [slot, typeof s === 'string' ? kitRef(s, `smp_${slot}_${s.replace(/\W/g, '')}`) : s] as const,
  );
  const ch = makeInstrumentChannel(
    def.name,
    makePluginInstance(
      def.id,
      def.version,
      { ...defaultValues(def.params), ...opts.params },
      refs.length ? { samples: Object.fromEntries(refs.map(([slot, r]) => [slot, r.id])) } : {},
    ),
  );
  const bars = opts.bars ?? 1;
  project = produce(project, (d) => {
    d.transport.bpm = opts.bpm ?? 120;
    for (const [, r] of refs) addSample(d, r);
    addChannel(d, ch);
    d.patterns[patternId]!.length = Math.round(bars * 3840);
    notes.forEach((n, i) =>
      addNote(d, patternId, ch.id, {
        id: `n${i}` as NoteId,
        tick: Math.round(n.at * 960),
        length: Math.max(1, Math.round(n.len * 960)),
        key: n.key,
        velocity: n.velocity ?? 1,
        ...(n.pan !== undefined ? { pan: n.pan } : {}),
        ...(n.fine !== undefined ? { fine: n.fine } : {}),
      }),
    );
  });
  return { project, patternId, channelId: ch.id };
}

/** Renders `notes` on one channel of `def` (pattern mode). */
export async function renderNotes(
  def: PluginDef,
  notes: readonly TestNote[],
  opts: InstrumentRender = {},
): Promise<AudioBuffer> {
  const { project, patternId } = instrumentProject(def, notes, opts);
  const { buffer } = await renderOffline(project, {
    plugins: resolver(def),
    view: { mode: 'pattern', patternId, loop: null },
    bars: opts.bars ?? 1,
    sampleRate: opts.sampleRate ?? SR,
    tail: opts.tail ?? 1,
    ...(opts.chunk ? { chunk: opts.chunk } : {}),
  });
  return buffer;
}

export interface Analysis {
  peak: number;
  rms: number;
  /** Mean of each channel. */
  dc: [number, number];
  finite: boolean;
}

export function analyze(buffer: AudioBuffer, from = 0, to = buffer.length): Analysis {
  let peak = 0;
  let sum = 0;
  let finite = true;
  const dc: [number, number] = [0, 0];
  const n = Math.max(1, to - from);
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    const d = buffer.getChannelData(c);
    let mean = 0;
    for (let i = from; i < to; i++) {
      const v = d[i] as number;
      if (!Number.isFinite(v)) finite = false;
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
      mean += v;
    }
    dc[c] = mean / n;
  }
  return { peak, rms: Math.sqrt(sum / (2 * n)), dc, finite };
}

/** RMS over [t0, t1) seconds after the music starts (both channels). */
export function rmsAt(buffer: AudioBuffer, t0: number, t1: number): number {
  const sr = buffer.sampleRate;
  const start = Math.round((PRE_ROLL * sr) / SR + Math.round(0.0013 * sr));
  return analyze(
    buffer,
    Math.min(buffer.length, start + Math.round(t0 * sr)),
    Math.min(buffer.length, start + Math.round(t1 * sr)),
  ).rms;
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (-2 * Math.PI) / size;
    for (let s = 0; s < n; s += size)
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = s + k;
        const b = a + size / 2;
        const tr = (re[b] as number) * wr - (im[b] as number) * wi;
        const ti = (re[b] as number) * wi + (im[b] as number) * wr;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
  }
}

/**
 * A sound's fingerprint: its energy (dB) in 24 log-spaced bands from 40 Hz to 16 kHz, averaged over
 * 2048-frame Hann windows, plus its loudness in 50 ms steps. Compare two with `fingerprintDistance`.
 */
export function fingerprint(buffer: AudioBuffer): { bands: number[]; envelope: number[] } {
  const N = 2048;
  const sr = buffer.sampleRate;
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] = (mono[i] as number) + (d[i] as number) / buffer.numberOfChannels;
  }
  const edges = Array.from({ length: 25 }, (_, i) => 40 * Math.pow(16000 / 40, i / 24));
  const bands = new Array<number>(24).fill(0);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let start = 0; start + N <= mono.length; start += N / 2) {
    for (let i = 0; i < N; i++) {
      re[i] = (mono[start + i] as number) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const hz = (k * sr) / N;
      const b = edges.findIndex((e, i) => i < 24 && hz >= e && hz < (edges[i + 1] as number));
      if (b >= 0) bands[b] = (bands[b] as number) + (re[k] as number) ** 2 + (im[k] as number) ** 2;
    }
  }
  const step = Math.round(0.05 * sr);
  const envelope: number[] = [];
  for (let s = 0; s + step <= mono.length; s += step) {
    let e = 0;
    for (let i = s; i < s + step; i++) e += (mono[i] as number) ** 2;
    envelope.push(10 * Math.log10(e / step + 1e-12));
  }
  return { bands: bands.map((e) => 10 * Math.log10(e + 1e-12)), envelope };
}

/** Mean absolute difference in dB between two fingerprints (spectrum and loudness over time). */
export function fingerprintDistance(a: AudioBuffer, b: AudioBuffer): number {
  const fa = fingerprint(a);
  const fb = fingerprint(b);
  const floor = (x: number) => Math.max(x, -100);
  let d = 0;
  for (let i = 0; i < fa.bands.length; i++) d += Math.abs(floor(fa.bands[i]!) - floor(fb.bands[i]!));
  let e = 0;
  const n = Math.min(fa.envelope.length, fb.envelope.length);
  for (let i = 0; i < n; i++) e += Math.abs(floor(fa.envelope[i]!) - floor(fb.envelope[i]!));
  return d / fa.bands.length + e / Math.max(1, n);
}
