/**
 * FL Studio project files (.flp): a reader that turns the event stream into plain records in FL's
 * own units (ticks at the file's PPQ, FL's value ranges). `flp-import.ts` maps them onto a Project.
 *
 * Layout: chunk "FLhd" (u32 length 6: i16 format, u16 channel count, u16 PPQ), then chunk "FLdt"
 * (u32 length) holding events. An event is an id byte and a value: ids 0–63 carry 1 byte, 64–127
 * 2 bytes, 128–191 4 bytes (little endian), 192–255 a LEB128 length and that many bytes. Text is
 * UTF-16LE from FL 11.5 on (the version text itself is always ASCII), single-byte before.
 *
 * The format is undocumented. Event ids and record layouts follow two open-source readers that
 * were checked against real files: PyFLP (github.com/demberto/PyFLP) and Monad's FLParser
 * (github.com/monadgroup/FLParser); where they disagree, the choice is noted next to the code.
 * Everything the importer doesn't use is skipped, unknown events included; damaged input gives an
 * FlpError with a readable message or, past the header, a warning and what could be read.
 */

export class FlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlpError';
  }
}

/** Event ids the reader understands (names after PyFLP's enums). */
export const FLP_EVENT = {
  channelEnabled: 0,
  channelVolByte: 2,
  channelPanByte: 3,
  timeSigNum: 17,
  timeSigBeat: 18,
  channelType: 21,
  channelRoutedTo: 22,
  markerNumerator: 33,
  markerDenominator: 34,
  channelNew: 64,
  patternNew: 65,
  tempoCoarse: 66,
  channelVolWord: 72,
  channelPanWord: 73,
  tempoFine: 93,
  channelChild: 94,
  insertIcon: 95,
  slotIndex: 98,
  arrangementNew: 99,
  arrangementCurrent: 100,
  pluginColor: 128,
  channelRootNote: 135,
  channelFineTune: 142,
  insertOutput: 147,
  markerPosition: 148,
  insertColor: 149,
  patternColor: 150,
  insertInput: 154,
  tempo: 156,
  channelName: 192,
  patternName: 193,
  title: 194,
  comments: 195,
  samplePath: 196,
  version: 199,
  pluginInternalName: 201,
  pluginName: 203,
  insertName: 204,
  markerName: 205,
  genre: 206,
  artist: 207,
  pluginData: 213,
  channelLevels: 219,
  patternNotes: 224,
  mixerParams: 225,
  automationLinks: 227,
  playlist: 233,
  channelAutomation: 234,
  insertRouting: 235,
  insertFlags: 236,
  trackData: 238,
  trackName: 239,
  arrangementName: 241,
} as const;

/** ChannelID.Type values. */
export const FLP_CHANNEL_TYPE = { sampler: 0, native: 2, layer: 3, instrument: 4, automation: 5 } as const;

/** Playlist items whose index is above this refer to patterns (index − base); others to channels. */
export const FLP_PATTERN_BASE = 20480;

/** Playlist record sizes seen across FL versions (flpkit: 32, 60, 80, 88 bytes). */
export const FLP_PLAYLIST_STRIDES = [32, 60, 80, 88] as const;

export const FLP_NOTE_SIZE = 24;
export const FLP_MIXER_PARAM_SIZE = 12;
export const FLP_AUTOMATION_LINK_SIZE = 20;
/** ChannelID.Automation: 21-byte header (point count at 17), then 24-byte points. */
export const FLP_AUTOMATION_HEADER = 21;
export const FLP_AUTOMATION_POINT_SIZE = 24;

/** Item flag for "muted in the playlist" (FLParser). */
export const FLP_ITEM_MUTED = 0x2000;
/** Note flag for slide notes. */
export const FLP_NOTE_SLIDE = 1 << 3;
/** Insert flag "enabled" (an insert without it is switched off). */
export const FLP_INSERT_ENABLED = 1 << 3;

/** Mixer param ids (MixerParams items). */
export const FLP_MIXER_PARAM = {
  slotEnabled: 0,
  slotMix: 1,
  routeFirst: 64,
  routeLast: 191,
  volume: 192,
  pan: 193,
} as const;

/** Size caps: beyond them the reader stops collecting and warns. */
export const FLP_LIMITS = {
  maxBytes: 512 * 1024 * 1024,
  maxChannels: 2000,
  maxPatterns: 10000,
  maxNotes: 2_000_000,
  maxItems: 500_000,
  maxInserts: 256,
  maxTracks: 500,
  maxMarkers: 10000,
  maxAutomationPoints: 100_000,
  maxText: 64 * 1024,
} as const;

export interface FlpVst {
  name?: string;
  vendor?: string;
}

export interface FlpAutomationPoint {
  /** Quarter notes from the start of the clip. */
  beats: number;
  /** 0–1. */
  value: number;
  tension: number;
}

export interface FlpChannel {
  /** The channel's FL index (ChannelID.New); notes and playlist items refer to it. */
  iid: number;
  /** ChannelID.Type (see FLP_CHANNEL_TYPE); null when absent. */
  type: number | null;
  /** The display name (PluginID.Name), falling back to ChannelID._Name. */
  name?: string;
  /** The generator's internal name: "Fruity Wrapper" for VST/AU, the plugin's factory name otherwise. */
  internalName?: string;
  vst?: FlpVst;
  samplePath?: string;
  /** 0–12800 (default 10000, nonlinear). */
  volume?: number;
  /** 0 (left) – 12800 (right), centre 6400. */
  pan?: number;
  /** Cents. */
  pitch?: number;
  /** FL key (60 = C5); default 60. */
  rootNote?: number;
  /** Mixer insert (0 = master, −1 = "current"). */
  insert?: number;
  /** "#rrggbb". */
  color?: string;
  enabled: boolean;
  /** Layer children (channel iids). */
  children: number[];
  automation?: FlpAutomationPoint[];
}

export interface FlpNote {
  /** Ticks at the file's PPQ. */
  position: number;
  flags: number;
  /** Channel iid. */
  channel: number;
  length: number;
  /** 0–131, 60 = C5. */
  key: number;
  /** 0–240, 120 = no detune. */
  fine: number;
  /** 0–128, default 64. */
  release: number;
  /** 0–128, 64 = centre. */
  pan: number;
  /** 0–128, default 100. */
  velocity: number;
  modX: number;
  modY: number;
}

export interface FlpPattern {
  /** FL pattern number (PatternID.New); playlist items refer to it. */
  iid: number;
  name?: string;
  color?: string;
  notes: FlpNote[];
}

export interface FlpPlaylistItem {
  /** Ticks at the file's PPQ. */
  position: number;
  length: number;
  /** Playlist track, 0 = the top one. */
  track: number;
  kind: 'pattern' | 'channel';
  /** Pattern iid or channel iid. */
  ref: number;
  muted: boolean;
  /** Content offset in ticks at the file's PPQ, or null for none. */
  startOffset: number | null;
  endOffset: number | null;
}

export interface FlpTrack {
  index: number;
  name?: string;
  color?: string;
  enabled: boolean;
}

export interface FlpMarker {
  /** Ticks at the file's PPQ. */
  position: number;
  name?: string;
  /** 0 = text marker, 1 = time signature marker, other = FL marker actions (loop, pause, …). */
  kind: number;
  numerator?: number;
  denominator?: number;
}

export interface FlpArrangement {
  index: number;
  name?: string;
  items: FlpPlaylistItem[];
  tracks: FlpTrack[];
  markers: FlpMarker[];
}

export interface FlpSlot {
  /** Slot number within the insert (SlotID.Index). */
  index: number;
  internalName?: string;
  name?: string;
  vst?: FlpVst;
  enabled?: boolean;
  /** FL's slot mix value (−6400…6400). */
  mix?: number;
}

export interface FlpInsert {
  /** 0 = master. */
  index: number;
  name?: string;
  color?: string;
  flags?: number;
  /** Route flags by target insert index (InsertID.Routing). */
  routing?: boolean[];
  /** Send levels by target insert (0–16000 scale), from the mixer params. */
  sends: Record<number, number>;
  /** 0–16000, 12800 = 0 dB. */
  volume?: number;
  /** −6400…6400. */
  pan?: number;
  slots: FlpSlot[];
}

export interface FlpAutomationLink {
  /** The automation channel's iid. */
  channel: number;
  param: number;
  destination: number;
}

export interface FlpProject {
  format: number;
  /** The header's channel count. */
  channelCount: number;
  /** Ticks per quarter note of every position in this file. */
  ppq: number;
  /** "21.2.3.4004"; empty when the file has no version event. */
  version: string;
  versionParts: number[];
  title?: string;
  artist?: string;
  genre?: string;
  comments?: string;
  /** BPM, or null when the file has none (FL then uses 140). */
  tempo: number | null;
  timeSig: { num: number; beat: number } | null;
  channels: FlpChannel[];
  patterns: FlpPattern[];
  arrangements: FlpArrangement[];
  /** Index of the arrangement that was open when saved, or null. */
  currentArrangement: number | null;
  inserts: FlpInsert[];
  automationLinks: FlpAutomationLink[];
  /** Plain-language notes on what was cut off or ignored. */
  warnings: string[];
  /** Events skipped because the reader doesn't use them. */
  skippedEvents: number;
}

/** File formats other than projects (PyFLP's FileFormat). */
const OTHER_FORMATS: Record<number, string> = {
  0x10: 'score',
  0x18: 'automation clip',
  0x20: 'channel state',
  0x30: 'plugin state',
  0x31: 'generator state',
  0x32: 'effect state',
  0x40: 'mixer insert state',
};

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** FL colours are COLORREF-style: bytes R, G, B, (alpha/unused). */
function colorOf(v: number): string {
  return `#${hex2(v & 0xff)}${hex2((v >>> 8) & 0xff)}${hex2((v >>> 16) & 0xff)}`;
}

function latin1(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i] as number);
  return s;
}

function utf16le(b: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i + 1 < len; i += 2)
    s += String.fromCharCode((b[off + i] as number) | ((b[off + i + 1] as number) << 8));
  return s;
}

function utf8(b: Uint8Array, off: number, len: number): string {
  let s = '';
  const end = off + len;
  let i = off;
  while (i < end) {
    const c = b[i++] as number;
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c >= 0xc0 && c < 0xe0 && i < end)
      s += String.fromCharCode(((c & 0x1f) << 6) | ((b[i++] as number) & 0x3f));
    else if (c >= 0xe0 && c < 0xf0 && i + 1 < end) {
      s += String.fromCharCode(((c & 0x0f) << 12) | (((b[i] as number) & 0x3f) << 6) | ((b[i + 1] as number) & 0x3f));
      i += 2;
    } else if (c >= 0xf0 && i + 2 < end) {
      const cp =
        ((c & 0x07) << 18) |
        (((b[i] as number) & 0x3f) << 12) |
        (((b[i + 1] as number) & 0x3f) << 6) |
        ((b[i + 2] as number) & 0x3f);
      i += 3;
      s += String.fromCodePoint(Math.min(cp, 0x10ffff));
    } else s += '�';
  }
  return s;
}

/** Drops trailing NULs and control characters (keeps tabs and line breaks). */
function clean(s: string): string {
  let out = '';
  for (const ch of s.replace(/\0+$/, '')) {
    const c = ch.charCodeAt(0);
    if (c >= 0x20 || c === 9 || c === 10 || c === 13) out += ch;
  }
  return out.trim();
}

/** Major.minor ≥ 11.5 stores text as UTF-16LE. */
function isUnicodeVersion(parts: number[]): boolean {
  const [major = 0, minor = 0] = parts;
  return major > 11 || (major === 11 && minor >= 5);
}

/** Whether `parts` ≥ `min` (lexicographic). */
export function flpVersionAtLeast(parts: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

class View {
  readonly dv: DataView;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8(o: number): number {
    return this.b[o] as number;
  }
  u16(o: number): number {
    return this.dv.getUint16(o, true);
  }
  i16(o: number): number {
    return this.dv.getInt16(o, true);
  }
  u32(o: number): number {
    return this.dv.getUint32(o, true);
  }
  i32(o: number): number {
    return this.dv.getInt32(o, true);
  }
  f32(o: number): number {
    return this.dv.getFloat32(o, true);
  }
  f64(o: number): number {
    return this.dv.getFloat64(o, true);
  }
  tag(o: number): string {
    return o + 4 <= this.b.length ? latin1(this.b, o, 4) : '';
  }
}

/** Parses a VST wrapper's plugin data: u32 type (8 or 10), then records (u32 id, u64 size, bytes). */
function parseVst(v: View, off: number, len: number): FlpVst | undefined {
  if (len < 4) return undefined;
  const type = v.u8(off);
  if (type !== 8 && type !== 10) return undefined;
  const out: FlpVst = {};
  let p = off + 4;
  const end = off + len;
  while (p + 12 <= end) {
    const id = v.u32(p);
    const lo = v.u32(p + 4);
    const hi = v.u32(p + 8);
    p += 12;
    if (hi !== 0 || p + lo > end) break;
    if (id === 54) out.name = clean(utf8(v.b, p, Math.min(lo, FLP_LIMITS.maxText)));
    else if (id === 56) out.vendor = clean(utf8(v.b, p, Math.min(lo, FLP_LIMITS.maxText)));
    p += lo;
  }
  return out.name || out.vendor ? out : undefined;
}

/** The record size of a playlist event: the stride whose every record has the pattern-base signature. */
export function playlistStride(v: View | Uint8Array, off: number, len: number): number | null {
  const view = v instanceof View ? v : new View(v);
  const fits = (s: number, all: boolean) => {
    if (len % s !== 0) return false;
    const n = all ? len / s : 1;
    for (let i = 0; i < n; i++) if (view.u16(off + i * s + 4) !== FLP_PATTERN_BASE) return false;
    return true;
  };
  for (const s of FLP_PLAYLIST_STRIDES) if (fits(s, true)) return s;
  for (const s of FLP_PLAYLIST_STRIDES) if (fits(s, false)) return s;
  return null;
}

/**
 * A playlist item offset. FLParser reads pattern items as int32 ticks and channel items as float32
 * beats; PyFLP reads both as float32. Pattern values that look like small integers are taken as
 * ticks, other bit patterns as floats (pattern floats as ticks, channel floats as beats). −1 = none.
 */
function itemOffset(v: View, o: number, pattern: boolean, ppq: number): number | null {
  const asInt = v.i32(o);
  if (asInt === -1) return null;
  if (pattern && Math.abs(asInt) < 1 << 24) return asInt >= 0 ? asInt : null;
  const f = v.f32(o);
  if (!Number.isFinite(f) || f < 0) return null;
  return pattern ? f : f * ppq;
}

/** Reads an .flp. Throws FlpError when the bytes aren't a readable FL Studio project. */
export function parseFlp(bytes: Uint8Array): FlpProject {
  if (bytes.length > FLP_LIMITS.maxBytes) {
    throw new FlpError(`This FL Studio project is too large to import (over ${FLP_LIMITS.maxBytes >> 20} MB).`);
  }
  const v = new View(bytes);
  if (v.tag(0) !== 'FLhd') throw new FlpError("This isn't an FL Studio project (.flp) file.");
  if (bytes.length < 14) throw new FlpError('The FL Studio project file is cut off (its header is incomplete).');
  const headerLen = v.u32(4);
  if (headerLen < 6 || headerLen > 4096 || 8 + headerLen > bytes.length) {
    throw new FlpError('The FL Studio project file is damaged (its header is invalid).');
  }
  const format = v.i16(8);
  const other = OTHER_FORMATS[format];
  if (other) throw new FlpError(`This is an FL Studio ${other} file, not a project.`);
  const channelCount = v.u16(10);
  const warnings: string[] = [];
  let ppq = v.u16(12);
  if (ppq < 1) {
    warnings.push('The file had no timing resolution; assumed 96 PPQ.');
    ppq = 96;
  }
  let pos = 8 + headerLen;
  if (v.tag(pos) !== 'FLdt') {
    // Tolerate stray bytes between the chunks.
    let found = -1;
    for (let p = pos; p + 4 <= Math.min(bytes.length, pos + 256); p++) {
      if (v.tag(p) === 'FLdt') {
        found = p;
        break;
      }
    }
    if (found < 0) throw new FlpError('The FL Studio project file has no project data.');
    pos = found;
  }
  if (pos + 8 > bytes.length) throw new FlpError('The FL Studio project file is cut off before its data.');
  const declared = v.u32(pos + 4);
  const start = pos + 8;
  let end = start + declared;
  if (end > bytes.length) {
    warnings.push('The file is cut off; what could be read was imported.');
    end = bytes.length;
  }

  const out: FlpProject = {
    format,
    channelCount,
    ppq,
    version: '',
    versionParts: [],
    tempo: null,
    timeSig: null,
    channels: [],
    patterns: [],
    arrangements: [],
    currentArrangement: null,
    inserts: [],
    automationLinks: [],
    warnings,
    skippedEvents: 0,
  };

  const channels = new Map<number, FlpChannel>();
  const pluginSeen = new Map<FlpChannel, Set<number>>();
  const patterns = new Map<number, FlpPattern>();
  let unicode: boolean | null = null;
  let ctx: 'project' | 'channel' | 'pattern' | 'arrangement' | 'mixer' = 'project';
  let ch: FlpChannel | null = null;
  let pat: FlpPattern | null = null;
  let arr: FlpArrangement | null = null;
  let marker: FlpMarker | null = null;
  let insertIndex = 0;
  let slot: FlpSlot | null = null;
  let tempoCoarse: number | null = null;
  let tempoFine = 0;
  let timeNum: number | null = null;
  let timeBeat: number | null = null;
  let totalNotes = 0;
  let totalItems = 0;
  let totalPoints = 0;
  const capped = new Set<string>();
  const cap = (what: string) => {
    if (capped.has(what)) return;
    capped.add(what);
    warnings.push(`The project has more ${what} than can be imported; the rest were left out.`);
  };
  const mixerParams: { insert: number; slot: number; id: number; value: number }[] = [];

  const text = (off: number, len: number): string => {
    const n = Math.min(len, FLP_LIMITS.maxText);
    // Before the version event (never in FL's own files): guess from the zero high bytes.
    const wide = unicode ?? (n >= 2 && n % 2 === 0 && bytes[off + 1] === 0);
    return clean(wide ? utf16le(bytes, off, n) : latin1(bytes, off, n));
  };
  const arrangement = (): FlpArrangement => {
    if (!arr) {
      arr = { index: 0, items: [], tracks: [], markers: [] };
      out.arrangements.push(arr);
    }
    return arr;
  };
  const insert = (): FlpInsert | null => {
    if (insertIndex >= FLP_LIMITS.maxInserts) {
      cap('mixer tracks');
      return null;
    }
    let ins = out.inserts[insertIndex];
    if (!ins) {
      ins = { index: insertIndex, sends: {}, slots: [] };
      out.inserts[insertIndex] = ins;
    }
    return ins;
  };
  const mixer = () => {
    if (ctx !== 'mixer') {
      ctx = 'mixer';
      slot = null;
    }
  };
  const currentSlot = (): FlpSlot => {
    slot ??= { index: -1 };
    return slot;
  };

  let p = start;
  while (p < end) {
    const id = bytes[p++] as number;
    let size: number;
    if (id < 64) size = 1;
    else if (id < 128) size = 2;
    else if (id < 192) size = 4;
    else {
      size = 0;
      let shift = 0;
      let ok = false;
      while (p < end && shift <= 28) {
        const c = bytes[p++] as number;
        size += (c & 0x7f) * 2 ** shift;
        shift += 7;
        if (!(c & 0x80)) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        warnings.push('The file is damaged near the end; what could be read was imported.');
        break;
      }
    }
    if (p + size > end) {
      warnings.push('The file is cut off; what could be read was imported.');
      break;
    }
    const at = p;
    p += size;
    const value = size === 1 ? v.u8(at) : size === 2 && id < 128 ? v.u16(at) : size === 4 && id < 192 ? v.u32(at) : 0;
    const E = FLP_EVENT;

    switch (id) {
      // --- Project -------------------------------------------------------------------------
      case E.version: {
        out.version = clean(latin1(bytes, at, Math.min(size, 64)));
        out.versionParts = out.version
          .split('.')
          .map((x) => Number.parseInt(x, 10))
          .filter((x) => Number.isFinite(x));
        unicode = isUnicodeVersion(out.versionParts);
        break;
      }
      case E.title:
        out.title = text(at, size);
        break;
      case E.artist:
        out.artist = text(at, size);
        break;
      case E.genre:
        out.genre = text(at, size);
        break;
      case E.comments:
        out.comments = text(at, size);
        break;
      case E.tempo:
        out.tempo = value / 1000;
        break;
      case E.tempoCoarse:
        tempoCoarse = value;
        break;
      case E.tempoFine:
        tempoFine = value;
        break;
      case E.timeSigNum:
        timeNum = value;
        break;
      case E.timeSigBeat:
        timeBeat = value;
        break;

      // --- Channels ------------------------------------------------------------------------
      case E.channelNew: {
        ctx = 'channel';
        let c = channels.get(value);
        if (!c) {
          if (channels.size >= FLP_LIMITS.maxChannels) {
            cap('channels');
            ch = null;
            break;
          }
          c = { iid: value, type: null, enabled: true, children: [] };
          channels.set(value, c);
          out.channels.push(c);
        }
        ch = c;
        break;
      }
      case E.channelType:
        if (ctx === 'channel' && ch) ch.type = value;
        break;
      case E.channelRoutedTo:
        if (ctx === 'channel' && ch) ch.insert = (value << 24) >> 24;
        break;
      case E.channelEnabled:
        if (ctx === 'channel' && ch) ch.enabled = value !== 0;
        break;
      case E.samplePath:
        if (ctx === 'channel' && ch) ch.samplePath = text(at, size);
        break;
      case E.channelName:
        // The display name (PluginID.Name) wins over this older name event.
        if (ctx === 'channel' && ch && !pluginSeen.get(ch)?.has(E.pluginName)) ch.name = text(at, size) || undefined;
        break;
      case E.channelLevels:
        if (ctx === 'channel' && ch) {
          if (size >= 4) ch.pan = v.i32(at);
          if (size >= 8) ch.volume = v.u32(at + 4);
          if (size >= 12) ch.pitch = v.i32(at + 8);
        }
        break;
      case E.channelVolWord:
        if (ctx === 'channel' && ch && ch.volume === undefined) ch.volume = value;
        break;
      case E.channelPanWord:
        if (ctx === 'channel' && ch && ch.pan === undefined) ch.pan = value;
        break;
      case E.channelVolByte:
        if (ctx === 'channel' && ch && ch.volume === undefined) ch.volume = value * 100;
        break;
      case E.channelPanByte:
        if (ctx === 'channel' && ch && ch.pan === undefined) ch.pan = value * 100;
        break;
      case E.channelRootNote:
        if (ctx === 'channel' && ch) ch.rootNote = value;
        break;
      case E.channelChild:
        if (ctx === 'channel' && ch && ch.children.length < 256) ch.children.push(value);
        break;
      case E.channelAutomation:
        if (ctx === 'channel' && ch && size >= FLP_AUTOMATION_HEADER) {
          const n = Math.min(v.u32(at + 17), Math.floor((size - FLP_AUTOMATION_HEADER) / FLP_AUTOMATION_POINT_SIZE));
          const points: FlpAutomationPoint[] = [];
          let x = 0;
          for (let i = 0; i < n; i++) {
            if (totalPoints >= FLP_LIMITS.maxAutomationPoints) {
              cap('automation points');
              break;
            }
            const o = at + FLP_AUTOMATION_HEADER + i * FLP_AUTOMATION_POINT_SIZE;
            const dx = v.f64(o);
            x += Number.isFinite(dx) ? dx : 0;
            const val = v.f64(o + 8);
            const tension = v.f32(o + 16);
            points.push({
              beats: x,
              value: Number.isFinite(val) ? val : 0,
              tension: Number.isFinite(tension) ? tension : 0,
            });
            totalPoints++;
          }
          ch.automation = points;
        }
        break;

      // --- Plugins: the channel's generator, or a mixer slot's effect ------------------------
      case E.pluginColor:
      case E.pluginInternalName:
      case E.pluginName:
      case E.pluginData: {
        if (ctx === 'channel' && ch) {
          // A channel has each of these once: a repeat means mixer slot data follows.
          let seen = pluginSeen.get(ch);
          if (!seen) pluginSeen.set(ch, (seen = new Set()));
          if (!seen.has(id)) {
            seen.add(id);
            if (id === E.pluginColor) ch.color = colorOf(value);
            else if (id === E.pluginInternalName) ch.internalName = text(at, size);
            else if (id === E.pluginName) ch.name = text(at, size) || ch.name;
            else ch.vst = parseVst(v, at, size);
            break;
          }
        }
        mixer();
        const s = currentSlot();
        if (id === E.pluginInternalName) s.internalName ??= text(at, size);
        else if (id === E.pluginName) s.name ??= text(at, size);
        else if (id === E.pluginData) s.vst ??= parseVst(v, at, size);
        break;
      }

      // --- Patterns ------------------------------------------------------------------------
      case E.patternNew: {
        ctx = 'pattern';
        let q = patterns.get(value);
        if (!q) {
          if (patterns.size >= FLP_LIMITS.maxPatterns) {
            cap('patterns');
            pat = null;
            break;
          }
          q = { iid: value, notes: [] };
          patterns.set(value, q);
          out.patterns.push(q);
        }
        pat = q;
        break;
      }
      case E.patternName:
        if (pat) pat.name = text(at, size) || undefined;
        break;
      case E.patternColor:
        if (pat) pat.color = colorOf(value);
        break;
      case E.patternNotes: {
        if (!pat) break;
        if (size % FLP_NOTE_SIZE !== 0) warnings.push('Some note data had an unexpected size; whole notes were read.');
        const n = Math.floor(size / FLP_NOTE_SIZE);
        for (let i = 0; i < n; i++) {
          if (totalNotes >= FLP_LIMITS.maxNotes) {
            cap('notes');
            break;
          }
          const o = at + i * FLP_NOTE_SIZE;
          pat.notes.push({
            position: v.u32(o),
            flags: v.u16(o + 4),
            channel: v.u16(o + 6),
            length: v.u32(o + 8),
            key: v.u16(o + 12),
            fine: v.u8(o + 16),
            release: v.u8(o + 18),
            pan: v.u8(o + 20),
            velocity: v.u8(o + 21),
            modX: v.u8(o + 22),
            modY: v.u8(o + 23),
          });
          totalNotes++;
        }
        break;
      }

      // --- Arrangements, playlist, tracks, markers ------------------------------------------
      case E.arrangementNew:
        ctx = 'arrangement';
        arr = { index: value, items: [], tracks: [], markers: [] };
        out.arrangements.push(arr);
        marker = null;
        break;
      case E.arrangementName:
        if (arr) arr.name = text(at, size) || undefined;
        break;
      case E.arrangementCurrent:
        out.currentArrangement = value;
        break;
      case E.playlist: {
        const a = arrangement();
        const stride = playlistStride(v, at, size);
        if (stride === null) {
          if (size > 0) warnings.push('Some playlist data had an unknown layout and was skipped.');
          break;
        }
        const n = size / stride;
        for (let i = 0; i < n; i++) {
          if (totalItems >= FLP_LIMITS.maxItems) {
            cap('playlist clips');
            break;
          }
          const o = at + i * stride;
          const index = v.u16(o + 6);
          const pattern = index > FLP_PATTERN_BASE;
          a.items.push({
            position: v.u32(o),
            length: v.u32(o + 8),
            // Stored reversed; the real index needs the version (resolved below).
            track: v.u16(o + 12),
            kind: pattern ? 'pattern' : 'channel',
            ref: pattern ? index - FLP_PATTERN_BASE : index,
            muted: (v.u16(o + 18) & FLP_ITEM_MUTED) !== 0,
            startOffset: itemOffset(v, o + 24, pattern, ppq),
            endOffset: itemOffset(v, o + 28, pattern, ppq),
          });
          totalItems++;
        }
        break;
      }
      case E.trackData: {
        const a = arrangement();
        if (a.tracks.length >= FLP_LIMITS.maxTracks) {
          cap('playlist tracks');
          break;
        }
        a.tracks.push({
          index: a.tracks.length,
          ...(size >= 8 ? { color: colorOf(v.u32(at + 4)) } : {}),
          enabled: size >= 13 ? v.u8(at + 12) !== 0 : true,
        });
        break;
      }
      case E.trackName: {
        const a = arrangement();
        const t = a.tracks[a.tracks.length - 1];
        if (t) t.name = text(at, size) || undefined;
        break;
      }
      case E.markerPosition: {
        const a = arrangement();
        if (a.markers.length >= FLP_LIMITS.maxMarkers) {
          cap('markers');
          marker = null;
          break;
        }
        marker = { position: value & 0x07ffffff, kind: value >>> 27 };
        a.markers.push(marker);
        break;
      }
      case E.markerName:
        if (marker) marker.name = text(at, size) || undefined;
        break;
      case E.markerNumerator:
        if (marker) marker.numerator = value;
        break;
      case E.markerDenominator:
        if (marker) marker.denominator = value;
        break;

      // --- Mixer ---------------------------------------------------------------------------
      case E.insertFlags: {
        mixer();
        const ins = insert();
        if (ins && size >= 8) ins.flags = v.u32(at + 4);
        break;
      }
      case E.insertName: {
        mixer();
        const ins = insert();
        if (ins) ins.name = text(at, size) || undefined;
        break;
      }
      case E.insertColor: {
        mixer();
        const ins = insert();
        if (ins) ins.color = colorOf(value);
        break;
      }
      case E.insertIcon:
      case E.insertInput:
        mixer();
        break;
      case E.slotIndex: {
        mixer();
        const ins = insert();
        const s = slot as FlpSlot | null;
        if (ins && s?.internalName) {
          s.index = value;
          if (ins.slots.length < 64) ins.slots.push(s);
        }
        slot = null;
        break;
      }
      case E.insertRouting: {
        mixer();
        // PyFLP ends an insert at its Output event, FLParser at its routing: a second routing for
        // the same insert means the file has no Output events, so the routing starts the next one.
        if (out.inserts[insertIndex]?.routing) insertIndex++;
        const ins = insert();
        if (ins) {
          const routing: boolean[] = [];
          for (let i = 0; i < Math.min(size, FLP_LIMITS.maxInserts); i++) routing.push(bytes[at + i] !== 0);
          ins.routing = routing;
        }
        break;
      }
      case E.insertOutput:
        mixer();
        insert();
        insertIndex++;
        slot = null;
        break;
      case E.mixerParams: {
        mixer();
        const n = Math.floor(size / FLP_MIXER_PARAM_SIZE);
        for (let i = 0; i < n; i++) {
          const o = at + i * FLP_MIXER_PARAM_SIZE;
          const cd = v.u16(o + 6);
          mixerParams.push({ id: v.u8(o + 4), insert: (cd >> 6) & 0x7f, slot: cd & 0x3f, value: v.i32(o + 8) });
        }
        break;
      }
      case E.automationLinks: {
        const n = Math.floor(size / FLP_AUTOMATION_LINK_SIZE);
        for (let i = 0; i < n && out.automationLinks.length < 10000; i++) {
          const o = at + i * FLP_AUTOMATION_LINK_SIZE;
          out.automationLinks.push({ channel: v.u8(o + 2), param: v.u16(o + 8), destination: v.u16(o + 10) });
        }
        break;
      }
      default:
        out.skippedEvents++;
    }
  }

  // Tempo: the modern dword (BPM × 1000), else the legacy coarse word plus fine thousandths.
  if (out.tempo === null && tempoCoarse !== null) out.tempo = tempoCoarse + tempoFine / 1000;
  if (out.tempo !== null && !(out.tempo > 0)) out.tempo = null;
  if (timeNum !== null || timeBeat !== null) out.timeSig = { num: timeNum ?? 4, beat: timeBeat ?? 4 };

  // Playlist tracks are stored reversed from the last one: 500 tracks from FL 12.9.1 on, 199 before.
  const modern =
    out.versionParts.length > 0
      ? flpVersionAtLeast(out.versionParts, [12, 9, 1])
      : out.arrangements.some((a) => a.items.some((it) => it.track > 198));
  const maxTrack = modern ? 499 : 198;
  for (const a of out.arrangements) {
    a.items = a.items.filter((it) => {
      const t = maxTrack - it.track;
      if (t < 0) return false;
      it.track = t;
      return true;
    });
  }

  // Mixer params: per-insert volume, pan and sends, and per-slot enabled/mix.
  for (const m of mixerParams) {
    const ins = out.inserts[m.insert];
    if (!ins) continue;
    if (m.id === FLP_MIXER_PARAM.volume) ins.volume = m.value;
    else if (m.id === FLP_MIXER_PARAM.pan) ins.pan = m.value;
    else if (m.id >= FLP_MIXER_PARAM.routeFirst && m.id <= FLP_MIXER_PARAM.routeLast)
      ins.sends[m.id - FLP_MIXER_PARAM.routeFirst] = m.value;
    else if (m.id === FLP_MIXER_PARAM.slotEnabled || m.id === FLP_MIXER_PARAM.slotMix) {
      const s = ins.slots.find((x) => x.index === m.slot);
      if (!s) continue;
      if (m.id === FLP_MIXER_PARAM.slotEnabled) s.enabled = m.value !== 0;
      else s.mix = m.value;
    }
  }
  // Holes (inserts with no events of their own) become empty inserts.
  for (let i = 0; i < out.inserts.length; i++) out.inserts[i] ??= { index: i, sends: {}, slots: [] };

  if (out.channels.length === 0 && out.patterns.length === 0 && out.arrangements.length === 0 && !out.version) {
    throw new FlpError('The FL Studio project file has no project data.');
  }
  return out;
}

/** Every distinct sample path the project's channels use. */
export function flpSamplePaths(flp: FlpProject): string[] {
  const set = new Set<string>();
  for (const c of flp.channels) if (c.samplePath) set.add(c.samplePath);
  return [...set];
}

/** The file name at the end of an FL path (Windows or Mac separators). */
export function flpFileName(path: string): string {
  return path.split(/[\\/]/).pop()?.trim() ?? path;
}
