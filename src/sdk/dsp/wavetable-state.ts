// Storing frames in a plugin's state (compact, versioned, validated) and building the band-limited bank from them.
import { clamp } from './math';
import { WavetableBank, type WavetableSpec } from './wavetable';
import { FRAME_HARMONICS, MAX_FRAMES, newFrame, type Frame } from './wavetable-frame';
import { frameAt, sineFrame } from './wavetable-frame-edit';

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

/** The state of a plugin whose table is not drawn yet. */
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
