// Drawable wavetables: the frames a user shapes (drawing, harmonics, imports), their compact storage in a plugin's
// state and the band-limited bank built from them. Pure TypeScript with no DOM; it runs on the main thread (editors,
// the AI's table ops) and in Node tests. Building a bank allocates, so do it off the audio thread and hand
// `bank.data` to the kernel (see the Wavetable's `onState`).
import { fft, WavetableBank, WT_HARMONICS, type WavetableSpec } from './wavetable';

/** Samples per cycle of the drawing buffer (`frameToWave`'s default size): 1024 points hold all 256 harmonics. */
export const FRAME_POINTS = 1024;
/** Harmonics a frame keeps (the richest mip level of a bank). */
export const FRAME_HARMONICS = WT_HARMONICS;
/** Key frames in one table. */
export const MAX_FRAMES = 32;

/**
 * One single-cycle shape as a Fourier series: x(t) = cos[0] + Σ cos[k]·cos(2πkt) + sin[k]·sin(2πkt), k = 1…256
 * (`cos[0]` is the DC offset, which a bank drops: it is not heard, and `removeDc` clears it).
 */
export interface Frame {
  readonly sin: Float64Array;
  readonly cos: Float64Array;
}

export function newFrame(): Frame {
  return { sin: new Float64Array(FRAME_HARMONICS + 1), cos: new Float64Array(FRAME_HARMONICS + 1) };
}

export function cloneFrame(f: Frame): Frame {
  return { sin: Float64Array.from(f.sin), cos: Float64Array.from(f.cos) };
}

/** A frame with nothing in it. */
export function isSilent(f: Frame): boolean {
  for (let k = 1; k <= FRAME_HARMONICS; k++) if (f.sin[k] !== 0 || f.cos[k] !== 0) return false;
  return true;
}

const isPow2 = (n: number) => n > 1 && (n & (n - 1)) === 0;
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

// ---------------------------------------------------------------------------------------------
// Time and frequency views.

/** One cycle of a frame as `out.length` points (a power of two, default `FRAME_POINTS`), DC included. */
export function frameToWave(f: Frame, out: Float32Array = new Float32Array(FRAME_POINTS)): Float32Array {
  const n = out.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const h = Math.min(FRAME_HARMONICS, n / 2 - 1);
  re[0] = f.cos[0] as number;
  for (let k = 1; k <= h; k++) {
    const c = (f.cos[k] as number) / 2;
    const s = (f.sin[k] as number) / 2;
    re[k] = c;
    im[k] = -s;
    re[n - k] = c;
    im[n - k] = s;
  }
  fft(re, im, n, true);
  for (let i = 0; i < n; i++) out[i] = re[i] as number;
  return out;
}

/** Averages `src` down to `m` points (a box filter over the fraction of the input each output point covers). */
export function boxResample(src: ArrayLike<number>, m: number): Float32Array {
  const n = src.length;
  const out = new Float32Array(m);
  const ratio = n / m;
  for (let i = 0; i < m; i++) {
    const a = i * ratio;
    const b = a + ratio;
    let sum = 0;
    for (let j = Math.floor(a); j < Math.min(n, Math.ceil(b)); j++) {
      const w = Math.min(b, j + 1) - Math.max(a, j);
      sum += (src[j] as number) * w;
    }
    out[i] = sum / ratio;
  }
  return out;
}

/** The longest cycle `frameFromWave` analyses directly; longer input is averaged down to it first. */
const MAX_ANALYSIS = 4096;

/**
 * The harmonics 1…256 (and the DC offset) of one cycle of audio of any length ≥ 4: a power of two goes through the
 * FFT, other lengths through a direct transform, so a single-cycle file of 600 or 2000 samples reads exactly.
 * A cycle shorter than 514 samples has fewer harmonics (up to n/2 − 1).
 */
export function frameFromWave(wave: ArrayLike<number>): Frame {
  const f = newFrame();
  let src: ArrayLike<number> = wave;
  if (src.length > MAX_ANALYSIS) src = boxResample(src, MAX_ANALYSIS);
  const n = src.length;
  if (n < 4) return f;
  const kmax = Math.min(FRAME_HARMONICS, (n >> 1) - 1);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += src[i] as number;
  f.cos[0] = mean / n;
  if (isPow2(n)) {
    const re = Float64Array.from(src);
    const im = new Float64Array(n);
    fft(re, im, n, false);
    for (let k = 1; k <= kmax; k++) {
      f.cos[k] = (2 * (re[k] as number)) / n;
      f.sin[k] = (-2 * (im[k] as number)) / n;
    }
    return f;
  }
  const cosT = new Float64Array(n);
  const sinT = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    cosT[j] = Math.cos((2 * Math.PI * j) / n);
    sinT[j] = Math.sin((2 * Math.PI * j) / n);
  }
  for (let k = 1; k <= kmax; k++) {
    let c = 0;
    let s = 0;
    for (let j = 0, idx = 0; j < n; j++, idx = (idx + k) % n) {
      const x = src[j] as number;
      c += x * (cosT[idx] as number);
      s += x * (sinT[idx] as number);
    }
    f.cos[k] = (2 * c) / n;
    f.sin[k] = (2 * s) / n;
  }
  return f;
}

/** The size of the largest peak of the frame's shape (DC included). */
export function peakOf(f: Frame): number {
  const w = frameToWave(f);
  let p = 0;
  for (let i = 0; i < w.length; i++) p = Math.max(p, Math.abs(w[i] as number));
  return p;
}

/** Strength of harmonics 1…count (√(sin² + cos²)). */
export function harmonicAmps(f: Frame, count: number): Float64Array {
  const out = new Float64Array(count);
  for (let k = 1; k <= count && k <= FRAME_HARMONICS; k++)
    out[k - 1] = Math.hypot(f.sin[k] as number, f.cos[k] as number);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Editing. Every function returns a new frame (or fills the buffer it is given) and leaves its input alone.

/**
 * Draws a straight stroke into a drawing buffer of one cycle: from (x0, y0) to (x1, y1), x as a fraction of the cycle
 * (0–1) and y from −1 to 1. Strokes may go either way; every point between the two is set.
 */
export function drawStroke(wave: Float32Array, x0: number, y0: number, x1: number, y1: number): void {
  const n = wave.length;
  const i0 = Math.round(clamp(x0, 0, 1) * (n - 1));
  const i1 = Math.round(clamp(x1, 0, 1) * (n - 1));
  const a = clamp(y0, -1, 1);
  const b = clamp(y1, -1, 1);
  if (i0 === i1) {
    wave[i1] = b;
    return;
  }
  const step = i1 > i0 ? 1 : -1;
  for (let i = i0; ; i += step) {
    wave[i] = a + ((b - a) * (i - i0)) / (i1 - i0);
    if (i === i1) break;
  }
}

/** Softens the shape: a Gaussian low-pass on the harmonics. `amount` 0–1 (1 leaves harmonic 12 at 60 %, 40+ gone). */
export function smoothFrame(f: Frame, amount: number): Frame {
  const out = cloneFrame(f);
  const sigma = clamp(amount, 0, 1) * 0.1;
  for (let k = 1; k <= FRAME_HARMONICS; k++) {
    const g = Math.exp(-0.5 * (k * sigma) ** 2);
    out.sin[k] = (f.sin[k] as number) * g;
    out.cos[k] = (f.cos[k] as number) * g;
  }
  return out;
}

/** Scales the frame so its highest peak is `peak` (default 1); a silent frame stays silent. */
export function normalizeFrame(f: Frame, peak = 1): Frame {
  const p = peakOf(f);
  const out = cloneFrame(f);
  if (!(p > 1e-9)) return out;
  const g = peak / p;
  for (let k = 0; k <= FRAME_HARMONICS; k++) {
    out.sin[k] = (out.sin[k] as number) * g;
    out.cos[k] = (out.cos[k] as number) * g;
  }
  return out;
}

/** Clears the DC offset (the shape then rises and falls equally around zero). */
export function removeDc(f: Frame): Frame {
  const out = cloneFrame(f);
  out.cos[0] = 0;
  return out;
}

/**
 * Brick-wall low-pass in the frequency domain: harmonics above `maxHarmonic` are removed (a mouse-drawn corner or an
 * imported edge brings very high harmonics that only add hiss). With `taper`, the last `taper` harmonics fade out
 * with a raised cosine instead of stopping at once (less ringing around jumps).
 */
export function bandLimit(f: Frame, maxHarmonic: number, taper = 0): Frame {
  const out = cloneFrame(f);
  const top = clamp(Math.round(maxHarmonic), 1, FRAME_HARMONICS);
  const t = Math.max(0, Math.min(Math.round(taper), top - 1));
  for (let k = 1; k <= FRAME_HARMONICS; k++) {
    let g = 1;
    if (k > top) g = 0;
    else if (t > 0 && k > top - t) g = 0.5 * (1 + Math.cos((Math.PI * (k - (top - t))) / (t + 1)));
    out.sin[k] = (f.sin[k] as number) * g;
    out.cos[k] = (f.cos[k] as number) * g;
  }
  return out;
}

/** A frame of sines with these strengths: `amps[0]` is the fundamental, `amps[1]` the 2nd harmonic, and so on. */
export function frameFromHarmonics(amps: ArrayLike<number>): Frame {
  const f = newFrame();
  for (let k = 1; k <= FRAME_HARMONICS && k <= amps.length; k++) {
    const a = Number(amps[k - 1]);
    f.sin[k] = Number.isFinite(a) ? Math.max(0, a) : 0;
  }
  return f;
}

/** Sets the strength of harmonic `k`, keeping its phase (a silent harmonic starts as a sine). */
export function setHarmonic(f: Frame, k: number, amp: number): Frame {
  const out = cloneFrame(f);
  if (k < 1 || k > FRAME_HARMONICS) return out;
  const a = Math.max(0, amp);
  const mag = Math.hypot(f.sin[k] as number, f.cos[k] as number);
  if (mag < 1e-12) {
    out.sin[k] = a;
    out.cos[k] = 0;
  } else {
    out.sin[k] = ((f.sin[k] as number) * a) / mag;
    out.cos[k] = ((f.cos[k] as number) * a) / mag;
  }
  return out;
}

/** Turns the shape upside down (the polarity of every harmonic flips). */
export function invertFrame(f: Frame): Frame {
  const out = cloneFrame(f);
  for (let k = 0; k <= FRAME_HARMONICS; k++) {
    out.sin[k] = -(f.sin[k] as number);
    out.cos[k] = -(f.cos[k] as number);
  }
  return out;
}

/** The shape played backwards (left to right mirrored). */
export function reverseFrame(f: Frame): Frame {
  const out = cloneFrame(f);
  for (let k = 1; k <= FRAME_HARMONICS; k++) out.sin[k] = -(f.sin[k] as number);
  return out;
}

/** A blend of two frames: `t` 0 = a, 1 = b. */
export function morphFrames(a: Frame, b: Frame, t: number): Frame {
  const out = newFrame();
  const u = clamp(t, 0, 1);
  for (let k = 0; k <= FRAME_HARMONICS; k++) {
    out.sin[k] = (a.sin[k] as number) * (1 - u) + (b.sin[k] as number) * u;
    out.cos[k] = (a.cos[k] as number) * (1 - u) + (b.cos[k] as number) * u;
  }
  return out;
}

/** `count` frames evenly between a and b (not including either). */
export function framesBetween(a: Frame, b: Frame, count: number): Frame[] {
  const out: Frame[] = [];
  for (let i = 1; i <= count; i++) out.push(morphFrames(a, b, i / (count + 1)));
  return out;
}

/** The table's shape at `position` (0–1): the key frames blended the way the oscillator blends them. */
export function frameAt(frames: readonly Frame[], position: number): Frame {
  if (frames.length === 0) return sineFrame();
  if (frames.length === 1) return frames[0] as Frame;
  const x = clamp(position, 0, 1) * (frames.length - 1);
  const i = Math.min(frames.length - 2, Math.floor(x));
  return morphFrames(frames[i] as Frame, frames[i + 1] as Frame, x - i);
}

/** A pure sine (what an empty table plays). */
export function sineFrame(): Frame {
  const f = newFrame();
  f.sin[1] = 1;
  return f;
}

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

// ---------------------------------------------------------------------------------------------
// Storage in a plugin's state: compact, versioned, validated.

/**
 * What a plugin with a drawable table keeps in its state (a plugin's `state` is part of the project, undoable and
 * saved with presets). Each key frame is one short string: see `encodeFrame`. `user: null` means no table yet.
 */
export interface UserTableState {
  /** State version: 2 is the first with a user table (1 had no state at all). */
  v: 2;
  user: { frames: string[] } | null;
}

export const EMPTY_TABLE_STATE: UserTableState = { v: 2, user: null };

/** The state for these key frames (an empty list clears the table). */
export function userTableState(frames: readonly Frame[]): UserTableState {
  if (frames.length === 0) return { v: 2, user: null };
  return { v: 2, user: { frames: frames.slice(0, MAX_FRAMES).map(encodeFrame) } };
}

/**
 * Any saved state as a valid one: nothing, an older shape or garbage becomes an empty table, and frames that don't
 * decode are dropped (so a damaged project still opens). Use it in `migrate` and wherever state is read.
 */
export function readUserTableState(raw: unknown): UserTableState {
  const user = (raw as { user?: { frames?: unknown } } | null | undefined)?.user;
  if (!user || !Array.isArray(user.frames)) return EMPTY_TABLE_STATE;
  const frames = user.frames.filter((s): s is string => typeof s === 'string' && decodeFrame(s) !== null).slice(0, MAX_FRAMES);
  return frames.length ? { v: 2, user: { frames } } : EMPTY_TABLE_STATE;
}

/** The key frames a state holds (none when it has no table). */
export function framesOfState(state: unknown): Frame[] {
  const s = readUserTableState(state);
  return (s.user?.frames ?? []).map((x) => decodeFrame(x) as Frame);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding (no `btoa`: this file also builds for the audio-thread configuration, which has no DOM). */
function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '=';
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '=';
  }
  return out;
}

/** The bytes of a base64 string, or null when it is not valid base64 (wrong characters, length or padding). */
function fromBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  for (let i = 0, o = 0; i < text.length; i += 4) {
    const n =
      (B64.indexOf(text[i] as string) << 18) |
      (B64.indexOf(text[i + 1] as string) << 12) |
      ((B64.indexOf(text[i + 2] as string) & 63) << 6) |
      (B64.indexOf(text[i + 3] as string) & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/**
 * One frame as a base64 string: highest harmonic (u16), a scale (f32), then the DC offset and each harmonic's cos and
 * sin as 16-bit integers of that scale (rounding error far below −60 dB of the peak). Harmonics above the last non-zero one are not
 * stored, so a smooth shape is a few hundred bytes and a full 256-harmonic one 1 KB.
 */
export function encodeFrame(f: Frame): string {
  let scale = Math.abs(f.cos[0] as number);
  for (let k = 1; k <= FRAME_HARMONICS; k++) scale = Math.max(scale, Math.abs(f.cos[k] as number), Math.abs(f.sin[k] as number));
  scale = Math.fround(scale);
  const q = (x: number) => (scale > 0 ? Math.round((clamp(x / scale, -1, 1)) * 32767) : 0);
  let top = 0;
  for (let k = 1; k <= FRAME_HARMONICS; k++) if (q(f.cos[k] as number) !== 0 || q(f.sin[k] as number) !== 0) top = k;
  const bytes = new Uint8Array(8 + 4 * top);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, top, true);
  dv.setFloat32(2, scale, true);
  dv.setInt16(6, q(f.cos[0] as number), true);
  for (let k = 1; k <= top; k++) {
    dv.setInt16(6 + 4 * k - 2, q(f.cos[k] as number), true);
    dv.setInt16(6 + 4 * k, q(f.sin[k] as number), true);
  }
  return toBase64(bytes);
}

/** The frame a string holds, or null when it is not one (wrong length, bad characters, absurd numbers). */
export function decodeFrame(text: string): Frame | null {
  const bytes = fromBase64(text);
  if (!bytes || bytes.length < 8) return null;
  const dv = new DataView(bytes.buffer);
  const top = dv.getUint16(0, true);
  const scale = dv.getFloat32(2, true);
  if (top > FRAME_HARMONICS || bytes.length !== 8 + 4 * top || !Number.isFinite(scale) || scale < 0 || scale > 1e6) return null;
  const f = newFrame();
  const g = scale / 32767;
  f.cos[0] = dv.getInt16(6, true) * g;
  for (let k = 1; k <= top; k++) {
    f.cos[k] = dv.getInt16(6 + 4 * k - 2, true) * g;
    f.sin[k] = dv.getInt16(6 + 4 * k, true) * g;
  }
  return f;
}

// ---------------------------------------------------------------------------------------------
// The band-limited bank.

/**
 * A wavetable spec of the key frames, evenly spaced from position 0 to 1 and blended between neighbours (what the
 * oscillator does with a bank whose frame count is the key-frame count).
 */
export function frameSpec(frames: readonly Frame[]): WavetableSpec {
  const list = frames.length ? frames : [sineFrame()];
  return {
    name: 'My table',
    frame(position, sin, cos) {
      const f = frameAt(list, position);
      for (let k = 1; k <= FRAME_HARMONICS && k < sin.length; k++) {
        sin[k] = f.sin[k] as number;
        cos[k] = f.cos[k] as number;
      }
    },
  };
}

/**
 * The bank of one table made of these key frames (every frame at all nine mip levels, so it never aliases): one
 * table, `frames.length` frames (an empty list makes one sine frame), peak-normalized per frame like the factory
 * tables. It takes about a millisecond per frame: build it on the main thread, never on the audio thread.
 */
export function buildFrameBank(frames: readonly Frame[], shared = false): WavetableBank {
  const list = frames.length ? frames.slice(0, MAX_FRAMES) : [sineFrame()];
  return WavetableBank.build([frameSpec(list)], list.length, shared);
}
