/**
 * A tiny container for derived audio kept on disk (time-stretched copies): 16-bit PCM, one channel
 * after the other, scaled by a gain so audio that overshoots full scale isn't clipped.
 *
 *   0  'AGP1'           magic
 *   4  u16 channels
 *   6  u16 reserved (0)
 *   8  u32 sample rate
 *   12 u32 frames
 *   16 f32 gain         sample = int16 / 32767 × gain
 *   20 int16 × frames × channels (little endian, planar)
 */
const MAGIC = 0x31504741; // 'AGP1' little endian
export const PCM16_HEADER = 20;

export interface Pcm16Info {
  channels: number;
  sampleRate: number;
  frames: number;
  gain: number;
}

/** Quantizes channels (rounding, no dither: the same input always gives the same bytes). */
export function encodePcm16(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const frames = channels[0]?.length ?? 0;
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i] as number));
  const gain = Math.fround(peak > 1 ? peak : 1);
  const out = new Uint8Array(PCM16_HEADER + frames * channels.length * 2);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, channels.length, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, Math.round(sampleRate), true);
  view.setUint32(12, frames, true);
  view.setFloat32(16, gain, true);
  const pcm = new Int16Array(out.buffer, PCM16_HEADER, frames * channels.length);
  const k = 32767 / gain;
  channels.forEach((c, ch) => {
    const o = ch * frames;
    for (let i = 0; i < frames; i++) {
      const v = Math.round((c[i] as number) * k);
      pcm[o + i] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
    }
  });
  return out;
}

/** The header, or null when these aren't such bytes (or are cut short). */
export function readPcm16Info(bytes: Uint8Array): Pcm16Info | null {
  if (bytes.byteLength < PCM16_HEADER) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return null;
  const info = {
    channels: view.getUint16(4, true),
    sampleRate: view.getUint32(8, true),
    frames: view.getUint32(12, true),
    gain: view.getFloat32(16, true),
  };
  if (info.channels === 0 || info.sampleRate === 0 || !(info.gain > 0)) return null;
  if (bytes.byteLength < PCM16_HEADER + info.frames * info.channels * 2) return null;
  return info;
}

/** Writes frames [from, to) of a channel as floats into `out` (from index 0). */
export function decodePcm16Range(bytes: Uint8Array, info: Pcm16Info, channel: number, from: number, to: number, out: Float32Array): void {
  // The samples may not be 2-byte aligned in `bytes`' buffer: read through a DataView then.
  const base = bytes.byteOffset + PCM16_HEADER + (channel * info.frames + from) * 2;
  const k = info.gain / 32767;
  const n = to - from;
  if (base % 2 === 0) {
    const pcm = new Int16Array(bytes.buffer, base, n);
    for (let i = 0; i < n; i++) out[i] = (pcm[i] as number) * k;
  } else {
    const view = new DataView(bytes.buffer, base, n * 2);
    for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) * k;
  }
}

/** All channels as floats. */
export function decodePcm16(bytes: Uint8Array): { info: Pcm16Info; channels: Float32Array[] } | null {
  const info = readPcm16Info(bytes);
  if (!info) return null;
  const channels = Array.from({ length: info.channels }, (_, c) => {
    const out = new Float32Array(info.frames);
    decodePcm16Range(bytes, info, c, 0, info.frames, out);
    return out;
  });
  return { info, channels };
}
