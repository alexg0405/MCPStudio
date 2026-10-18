// Frames from audio: averaging, slicing and cycle detection for imported samples, and the WAV reader and writer the
// importer and exporter use.
import { MAX_ANALYSIS, MAX_FRAMES, boxResample, frameFromWave, frameToWave, type Frame } from './wavetable-frame';
import { normalizeFrame, removeDc, sineFrame } from './wavetable-frame-edit';

// ---------------------------------------------------------------------------------------------
// Importing audio.

/** Averages a file's channels into one. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (c[i] as number) / channels.length;
  return out;
}

/** Keeps at most `max` of the frames, evenly spread (a 256-frame table becomes its 32 most representative). */
export function thin<T>(items: readonly T[], max = MAX_FRAMES): T[] {
  if (items.length <= max) return [...items];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))] as T);
  return out;
}

/**
 * Frames from a single-cycle recording, or a table of cycles one after another (`cycleLength` samples each: 2048 is
 * the usual one): each cycle's harmonics, with its DC removed and its peak at 1. A file with more than 32 cycles
 * keeps 32 evenly spread. A file shorter than one cycle is taken whole as one cycle.
 */
export function framesFromCycles(samples: ArrayLike<number>, cycleLength: number): Frame[] {
  const len = Math.max(4, Math.floor(cycleLength));
  const count = Math.max(1, Math.floor(samples.length / len));
  const cycles: ArrayLike<number>[] = [];
  const view = samples as { subarray?(a: number, b: number): ArrayLike<number> };
  for (let i = 0; i < count; i++) {
    const a = i * len;
    cycles.push(count === 1 ? samples : view.subarray ? view.subarray(a, a + len) : Array.prototype.slice.call(samples, a, a + len));
  }
  return thin(cycles).map((c) => normalizeFrame(removeDc(frameFromWave(c))));
}

/**
 * Cuts audio into `count` equal parts and reads each part as one cycle: a sample's changing sound becomes a table
 * that morphs through it. The parts are faded in and out (a Hann window) by default, because a cut that doesn't meet
 * itself makes a buzzing jump at the loop point; `windowed: false` keeps the raw cut.
 */
export function framesFromSlices(samples: ArrayLike<number>, count: number, windowed = true): Frame[] {
  const parts = Math.max(1, Math.min(MAX_FRAMES, Math.floor(count)));
  const out: Frame[] = [];
  const n = samples.length;
  for (let i = 0; i < parts; i++) {
    const a = Math.floor((i * n) / parts);
    const b = Math.floor(((i + 1) * n) / parts);
    const slice = Array.prototype.slice.call(samples, a, b) as number[];
    let cycle: ArrayLike<number> = slice.length > MAX_ANALYSIS ? boxResample(slice, MAX_ANALYSIS) : slice;
    if (windowed && cycle.length > 4) {
      const w = new Float32Array(cycle.length);
      for (let j = 0; j < w.length; j++) w[j] = (cycle[j] as number) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (j + 0.5)) / w.length));
      cycle = w;
    }
    out.push(normalizeFrame(removeDc(frameFromWave(cycle))));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// WAV files (the importer's and exporter's own reader and writer: no DOM needed).

export interface DecodedWav {
  channels: Float32Array[];
  sampleRate: number;
  /** The cycle length a wavetable file announces in its `clm ` chunk (Serum, Vital and AGstudio write one), or 0. */
  cycleLength: number;
}

/** Reads a RIFF/WAVE file: 8, 16, 24 and 32-bit PCM and 32 and 64-bit float, any channel count. Null when it is not one. */
export function decodeWav(bytes: Uint8Array): DecodedWav | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: [number, number] | null = null;
  let cycleLength = 0;
  for (let o = 12; o + 8 <= bytes.length; ) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = dv.getUint16(body, true);
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true);
    } else if (id === 'data') data = [body, Math.min(size, bytes.length - body)];
    else if (id === 'clm ') {
      const m = /^<!>(\d+)/.exec(String.fromCharCode(...bytes.subarray(body, Math.min(bytes.length, body + Math.min(size, 40)))));
      if (m) cycleLength = Number(m[1]);
    }
    o = body + size + (size & 1);
  }
  if (!data || channels < 1 || sampleRate < 1) return null;
  const bytesPer = bits >> 3;
  const float = format === 3;
  if (!(format === 1 || float) || ![1, 2, 3, 4, 8].includes(bytesPer) || (float && bytesPer !== 4 && bytesPer !== 8)) return null;
  const frames = Math.floor(data[1] / (bytesPer * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const o = data[0] + (i * channels + c) * bytesPer;
      let v: number;
      if (float) v = bytesPer === 4 ? dv.getFloat32(o, true) : dv.getFloat64(o, true);
      else if (bytesPer === 1) v = (dv.getUint8(o) - 128) / 128;
      else if (bytesPer === 2) v = dv.getInt16(o, true) / 32768;
      else if (bytesPer === 3) v = (((dv.getUint8(o + 2) << 16) | (dv.getUint8(o + 1) << 8) | dv.getUint8(o)) << 8 >> 8) / 8388608;
      else v = dv.getInt32(o, true) / 2147483648;
      (out[c] as Float32Array)[i] = v;
    }
  return { channels: out, sampleRate, cycleLength };
}

/**
 * The table as a 32-bit float mono WAV: every frame as `points` samples (2048 is the usual size), one after another,
 * with a `clm ` chunk announcing the cycle size so other wavetable synths (Serum, Vital) load it as a table. Each frame
 * is exported as it plays: no DC, peak 1.
 */
export function encodeWav(frames: readonly Frame[], points = 2048, sampleRate = 44100): Uint8Array {
  const list = frames.length ? frames : [sineFrame()];
  const clm = `<!>${points} 20000000 wavetable (AGstudio)`;
  const clmSize = clm.length + (clm.length & 1);
  const dataSize = list.length * points * 4;
  const out = new Uint8Array(12 + 24 + 8 + clmSize + 8 + dataSize);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  put(0, 'RIFF');
  dv.setUint32(4, out.length - 8, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 32, true);
  put(36, 'clm ');
  dv.setUint32(40, clm.length, true);
  put(44, clm);
  const dataAt = 44 + clmSize;
  put(dataAt, 'data');
  dv.setUint32(dataAt + 4, dataSize, true);
  const wave = new Float32Array(points);
  list.forEach((f, i) => {
    frameToWave(normalizeFrame(removeDc(f)), wave);
    for (let j = 0; j < points; j++) dv.setFloat32(dataAt + 8 + (i * points + j) * 4, wave[j] as number, true);
  });
  return out;
}
