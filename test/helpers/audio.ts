/**
 * Signal helpers for the M15 audio tests (Node unit tests and browser tests): test tones, pitch
 * and onset measurements, envelopes, and projects with audio clips. Pure TypeScript, no DOM.
 */
import { produce } from 'immer';
import { encodeWav } from '@core/io/wav';
import { createEmptyProject } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import {
  MASTER,
  type AudioClip,
  type AudioClipChannel,
  type ChannelId,
  type ClipId,
  type LaneId,
  type Project,
  type SampleRef,
} from '@core/model/types';

/** A harmonic tone (fundamental + 2nd and 3rd harmonics) of `seconds` at `hz`. */
export function harmonicTone(hz: number, seconds: number, sampleRate: number, level = 0.5): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] =
      level *
      (0.6 * Math.sin(2 * Math.PI * hz * t) +
        0.3 * Math.sin(2 * Math.PI * 2 * hz * t) +
        0.1 * Math.sin(2 * Math.PI * 3 * hz * t));
  }
  return out;
}

/** Short decaying clicks (5 ms) every `every` seconds starting at `first`. */
export function clickTrain(every: number, seconds: number, sampleRate: number, first = 0.1): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let t = first; t < seconds; t += every) {
    const at = Math.round(t * sampleRate);
    for (let k = 0; k < Math.round(0.005 * sampleRate) && at + k < n; k++)
      out[at + k] = 0.9 * Math.exp(-k / (0.001 * sampleRate)) * (k % 2 ? -1 : 1);
  }
  return out;
}

/**
 * Fundamental frequency of `x[from…to)` by autocorrelation: the strongest lag between 1/maxHz and
 * 1/minHz (the first peak within 10 % of the best, so octave errors don't win), refined with a
 * parabola.
 */
export function autocorrelationPitch(
  x: Float32Array,
  sampleRate: number,
  from = 0,
  to = x.length,
  minHz = 50,
  maxHz = 1000,
): number {
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.ceil(sampleRate / minHz);
  const len = to - from - maxLag;
  if (len <= 0) return NaN;
  const r = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = from; i < from + len; i++) s += (x[i] as number) * (x[i + lag] as number);
    r[lag] = s;
  }
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if ((r[lag] as number) > (r[best] as number)) best = lag;
  // The first local maximum close to the best one (avoids picking a multiple of the period).
  for (let lag = minLag; lag < best; lag++) {
    const v = r[lag] as number;
    if (v >= 0.9 * (r[best] as number) && v >= (r[lag - 1] as number) && v >= (r[lag + 1] as number)) {
      best = lag;
      break;
    }
  }
  const a = r[best - 1] as number;
  const b = r[best] as number;
  const c = r[best + 1] as number;
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return sampleRate / (best + shift);
}

/** Frames where |x| first rises above `threshold` after at least `gap` seconds below it. */
export function onsetFrames(x: Float32Array, sampleRate: number, threshold = 0.2, gap = 0.05): number[] {
  const minGap = Math.round(gap * sampleRate);
  const out: number[] = [];
  let lastLoud = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i] as number) > threshold) {
      if (i - lastLoud > minGap) out.push(i);
      lastLoud = i;
    }
  }
  return out;
}

/** RMS of x[from…to). */
export function rmsOf(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Peak |x| of x[from…to). */
export function peakOf(x: Float32Array, from = 0, to = x.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i] as number));
  return m;
}

/** A constant-level test signal: a sine at `hz` (its envelope is easy to read back). */
export function sine(hz: number, seconds: number, sampleRate: number, level = 0.5): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = level * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/** Linear ramp 0 → `top` over the whole signal (reverse playback reads it backwards). */
export function ramp(seconds: number, sampleRate: number, top = 1): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (top * i) / n;
  return out;
}

// ---------------------------------------------------------------- projects with audio clips

export interface AudioClipSpec {
  start: number;
  length: number;
  offsetSec?: number;
  lane?: number;
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
}

let sampleSeq = 0;

/** Sample bytes by hash for an engine's `samples` option (32-bit float WAV, so they decode exactly). */
export class TestSamples {
  private readonly bytes = new Map<string, Uint8Array>();
  add(channels: Float32Array[], sampleRate: number, name = 'Test sound'): SampleRef {
    const wav = encodeWav(channels, sampleRate, { bitDepth: 32 });
    // Unique per sample: the engine's decode cache keys embedded samples by their hash.
    const hash = (++sampleSeq).toString(16).padStart(64, 'a');
    this.bytes.set(hash, wav);
    return {
      id: newId.sample(),
      name,
      source: { kind: 'embedded', hash, ext: 'wav' },
      durationSec: (channels[0]?.length ?? 0) / sampleRate,
      sampleRate,
      channels: channels.length,
    };
  }
  readonly provider = {
    getBytes: async (ref: SampleRef): Promise<ArrayBuffer | null> => {
      if (ref.source.kind !== 'embedded') return null;
      const b = this.bytes.get(ref.source.hash);
      return b ? (b.slice().buffer as ArrayBuffer) : null;
    },
  };
}

/**
 * A project with one audio clip channel (volume 1, centre, to the master) playing `sample` in the
 * given clips, at `bpm`. `channel` sets pitch/reverse/stretch.
 */
export function audioClipProject(
  sample: SampleRef,
  clips: AudioClipSpec[],
  opts: { bpm?: number; channel?: Partial<AudioClipChannel> } = {},
): { project: Project; channelId: ChannelId; clipIds: ClipId[] } {
  const ch: AudioClipChannel = {
    kind: 'audioClip',
    id: newId.channel(),
    name: sample.name,
    color: '#5f8fbf',
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    output: MASTER,
    sampleId: sample.id,
    ...opts.channel,
  };
  const clipIds: ClipId[] = [];
  const project = produce(createEmptyProject(), (d) => {
    d.transport.bpm = opts.bpm ?? 120;
    d.samples[sample.id] = sample;
    d.channels[ch.id] = ch;
    d.channelOrder.push(ch.id);
    for (const c of clips) {
      const id = newId.clip();
      clipIds.push(id);
      const clip: AudioClip = {
        kind: 'audio',
        id,
        laneId: d.playlist.laneOrder[c.lane ?? 0] as LaneId,
        start: c.start,
        length: c.length,
        channelId: ch.id,
        offsetSec: c.offsetSec ?? 0,
        ...(c.gain !== undefined ? { gain: c.gain } : {}),
        ...(c.fadeIn !== undefined ? { fadeIn: c.fadeIn } : {}),
        ...(c.fadeOut !== undefined ? { fadeOut: c.fadeOut } : {}),
      };
      d.playlist.clips[id] = clip;
    }
  });
  return { project, channelId: ch.id, clipIds };
}
