/** Decoders for the binary payloads inside .flp events whose layout is more than a single number. */
import { FlpView, cleanText, utf8 } from './flp-bytes';
import {
  FLP_LIMITS,
  FLP_NOTE,
  FLP_PATTERN_BASE,
  FLP_PLAYLIST_ITEM,
  FLP_PLAYLIST_STRIDES,
  type FlpNote,
  type FlpVst,
} from './flp-format';

/** The VST wrapper's plugin data starts with a type; these two are the ones that hold named records. */
const VST_DATA_TYPES = [8, 10];
/** Bytes of a record header inside VST data: u32 id, u64 size. */
const VST_RECORD_HEADER_BYTES = 12;
/** Record ids inside VST data (from the files checked): the plugin's name and its vendor, as UTF-8. */
const VST_RECORD_NAME = 54;
const VST_RECORD_VENDOR = 56;
/** Playlist offsets that read as integers below this are ticks (see `itemOffset`). */
const SMALL_INTEGER_LIMIT = 1 << 24;

/** Parses a VST wrapper's plugin data: a type (8 or 10), then records (u32 id, u64 size, bytes). */
export function parseVst(view: FlpView, offset: number, length: number): FlpVst | undefined {
  if (length < 4) return undefined;
  if (!VST_DATA_TYPES.includes(view.u8(offset))) return undefined;
  const vst: FlpVst = {};
  let at = offset + 4;
  const end = offset + length;
  while (at + VST_RECORD_HEADER_BYTES <= end) {
    const id = view.u32(at);
    const sizeLow = view.u32(at + 4);
    const sizeHigh = view.u32(at + 8);
    at += VST_RECORD_HEADER_BYTES;
    if (sizeHigh !== 0 || at + sizeLow > end) break;
    const textLength = Math.min(sizeLow, FLP_LIMITS.maxText);
    if (id === VST_RECORD_NAME) vst.name = cleanText(utf8(view.bytes, at, textLength));
    else if (id === VST_RECORD_VENDOR) vst.vendor = cleanText(utf8(view.bytes, at, textLength));
    at += sizeLow;
  }
  return vst.name || vst.vendor ? vst : undefined;
}

/**
 * The record size of a playlist event: the stride whose every record has the pattern-base signature, else
 * the first stride whose first record does. Null when none fits.
 */
export function playlistStride(source: FlpView | Uint8Array, offset: number, length: number): number | null {
  const view = source instanceof FlpView ? source : new FlpView(source);
  const fits = (stride: number, checkEveryRecord: boolean) => {
    if (length % stride !== 0) return false;
    const recordCount = checkEveryRecord ? length / stride : 1;
    for (let i = 0; i < recordCount; i++) {
      if (view.u16(offset + i * stride + FLP_PLAYLIST_ITEM.patternBase) !== FLP_PATTERN_BASE) return false;
    }
    return true;
  };
  for (const stride of FLP_PLAYLIST_STRIDES) if (fits(stride, true)) return stride;
  for (const stride of FLP_PLAYLIST_STRIDES) if (fits(stride, false)) return stride;
  return null;
}

/**
 * A playlist item offset. FLParser reads pattern items as int32 ticks and channel items as float32
 * beats; PyFLP reads both as float32. Pattern values that look like small integers are taken as
 * ticks, other bit patterns as floats (pattern floats as ticks, channel floats as beats). −1 = none.
 */
export function itemOffset(view: FlpView, offset: number, isPattern: boolean, ppq: number): number | null {
  const asInt = view.i32(offset);
  if (asInt === -1) return null;
  if (isPattern && Math.abs(asInt) < SMALL_INTEGER_LIMIT) return asInt >= 0 ? asInt : null;
  const asFloat = view.f32(offset);
  if (!Number.isFinite(asFloat) || asFloat < 0) return null;
  return isPattern ? asFloat : asFloat * ppq;
}

/** Reads the note record that starts at byte `offset` (see FLP_NOTE for the layout). Runs once per note. */
export function readNote(view: FlpView, offset: number): FlpNote {
  return {
    position: view.u32(offset + FLP_NOTE.position),
    flags: view.u16(offset + FLP_NOTE.flags),
    channel: view.u16(offset + FLP_NOTE.channel),
    length: view.u32(offset + FLP_NOTE.length),
    key: view.u16(offset + FLP_NOTE.key),
    fine: view.u8(offset + FLP_NOTE.fine),
    release: view.u8(offset + FLP_NOTE.release),
    pan: view.u8(offset + FLP_NOTE.pan),
    velocity: view.u8(offset + FLP_NOTE.velocity),
    modX: view.u8(offset + FLP_NOTE.modX),
    modY: view.u8(offset + FLP_NOTE.modY),
  };
}
