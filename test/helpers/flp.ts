/**
 * A test-side FL Studio project writer: builds .flp bytes per the documented layout (see
 * src/core/io/flp.ts) so the reader and importer can be tested without FL. Not a faithful FL file
 * writer: it emits only the events the tests need, in FL's usual order.
 */
import { FLP_EVENT as E, FLP_PATTERN_BASE } from '@core/io/flp';

export type FlpEvent = { id: number; data: Uint8Array };

const le = (n: number, size: number) => {
  const b = new Uint8Array(size);
  const dv = new DataView(b.buffer);
  if (size === 1) dv.setUint8(0, n & 0xff);
  else if (size === 2) dv.setUint16(0, n & 0xffff, true);
  else dv.setUint32(0, n >>> 0, true);
  return b;
};

export function ev(id: number, value: number): FlpEvent {
  return { id, data: le(value, id < 64 ? 1 : id < 128 ? 2 : 4) };
}

export function data(id: number, bytes: Uint8Array): FlpEvent {
  return { id, data: bytes };
}

export function utf16(s: string): Uint8Array {
  const b = new Uint8Array((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) {
    b[i * 2] = s.charCodeAt(i) & 0xff;
    b[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  return b;
}

export function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

/** A text event in the encoding of `version` (UTF-16 from 11.5). */
export function text(id: number, s: string, unicode = true): FlpEvent {
  return data(id, unicode ? utf16(s) : ascii(s));
}

export function color(r: number, g: number, b: number): number {
  return r | (g << 8) | (b << 16);
}

function varint(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The whole file: FLhd (format 0) + FLdt with the events. */
export function flpFile(
  events: FlpEvent[],
  opts: { ppq?: number; channels?: number; format?: number } = {},
): Uint8Array {
  const body: Uint8Array[] = [];
  for (const e of events) {
    if (e.id < 192) body.push(Uint8Array.of(e.id), e.data);
    else body.push(Uint8Array.of(e.id, ...varint(e.data.length)), e.data);
  }
  const events_ = concat(body);
  const head = new Uint8Array(22);
  const dv = new DataView(head.buffer);
  head.set([0x46, 0x4c, 0x68, 0x64]); // FLhd
  dv.setUint32(4, 6, true);
  dv.setInt16(8, opts.format ?? 0, true);
  dv.setUint16(10, opts.channels ?? 0, true);
  dv.setUint16(12, opts.ppq ?? 96, true);
  head.set([0x46, 0x4c, 0x64, 0x74], 14); // FLdt
  dv.setUint32(18, events_.length, true);
  return concat([head, events_]);
}

export interface NoteSpec {
  position: number;
  channel: number;
  length: number;
  key: number;
  velocity?: number;
  pan?: number;
  release?: number;
  fine?: number;
  flags?: number;
}

export function notes(list: NoteSpec[]): FlpEvent {
  const b = new Uint8Array(list.length * 24);
  const dv = new DataView(b.buffer);
  list.forEach((n, i) => {
    const o = i * 24;
    dv.setUint32(o, n.position, true);
    dv.setUint16(o + 4, n.flags ?? 0x4000, true);
    dv.setUint16(o + 6, n.channel, true);
    dv.setUint32(o + 8, n.length, true);
    dv.setUint16(o + 12, n.key, true);
    b[o + 16] = n.fine ?? 120;
    b[o + 18] = n.release ?? 64;
    b[o + 20] = n.pan ?? 64;
    b[o + 21] = n.velocity ?? 100;
    b[o + 22] = 128;
    b[o + 23] = 128;
  });
  return data(E.patternNotes, b);
}

export interface ItemSpec {
  position: number;
  length: number;
  /** 0 = top track. */
  track: number;
  pattern?: number;
  channel?: number;
  muted?: boolean;
  /** Pattern items: int ticks; channel items: float beats. Absent = −1 (none). */
  startOffset?: number;
  endOffset?: number;
  /** Write pattern offsets as float32 (PyFLP's reading) instead of int32. */
  floatOffsets?: boolean;
}

/** A playlist event; `stride` 32 (classic), 60 (FL 21) or 80/88. `maxTrack` 499 (12.9.1+) or 198. */
export function playlist(items: ItemSpec[], opts: { stride?: number; maxTrack?: number } = {}): FlpEvent {
  const stride = opts.stride ?? 32;
  const maxTrack = opts.maxTrack ?? 499;
  const b = new Uint8Array(items.length * stride);
  const dv = new DataView(b.buffer);
  items.forEach((it, i) => {
    const o = i * stride;
    const isPattern = it.pattern !== undefined;
    dv.setUint32(o, it.position, true);
    dv.setUint16(o + 4, FLP_PATTERN_BASE, true);
    dv.setUint16(o + 6, isPattern ? FLP_PATTERN_BASE + (it.pattern as number) : (it.channel ?? 0), true);
    dv.setUint32(o + 8, it.length, true);
    dv.setUint16(o + 12, maxTrack - it.track, true);
    b[o + 16] = 120;
    dv.setUint16(o + 18, 64 | (it.muted ? 0x2000 : 0), true);
    b.set([64, 100, 128, 128], o + 20);
    const off = (at: number, v: number | undefined) => {
      if (v === undefined) dv.setInt32(at, -1, true);
      else if (isPattern && !it.floatOffsets) dv.setInt32(at, v, true);
      else dv.setFloat32(at, v, true);
    };
    off(o + 24, it.startOffset);
    off(o + 28, it.endOffset);
  });
  return data(E.playlist, b);
}

/** ChannelID.Levels: pan (0–12800), volume (0–12800), pitch (cents). */
export function levels(pan: number, volume: number, pitch = 0): FlpEvent {
  const b = new Uint8Array(24);
  const dv = new DataView(b.buffer);
  dv.setInt32(0, pan, true);
  dv.setUint32(4, volume, true);
  dv.setInt32(8, pitch, true);
  return data(E.channelLevels, b);
}

/** A VST wrapper's plugin data with its name (and vendor). */
export function vstData(name: string, vendor = ''): FlpEvent {
  const rec = (id: number, s: string) => {
    const bytes = new TextEncoder().encode(s);
    const h = new Uint8Array(12);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, id, true);
    dv.setUint32(4, bytes.length, true);
    return concat([h, bytes]);
  };
  return data(
    E.pluginData,
    concat([le(10, 4), rec(1, '\0\0\0\0'), rec(54, name), ...(vendor ? [rec(56, vendor)] : [])]),
  );
}

export function trackData(index: number, opts: { color?: number; enabled?: boolean } = {}): FlpEvent {
  const b = new Uint8Array(66);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, index + 1, true);
  dv.setUint32(4, opts.color ?? color(0x56, 0x51, 0x48), true);
  b[12] = opts.enabled === false ? 0 : 1;
  return data(E.trackData, b);
}

export function automationPoints(points: { beats: number; value: number; tension?: number }[]): FlpEvent {
  const b = new Uint8Array(21 + points.length * 24 + 4);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 1, true);
  dv.setUint32(17, points.length, true);
  let prev = 0;
  points.forEach((p, i) => {
    const o = 21 + i * 24;
    dv.setFloat64(o, i === 0 ? p.beats : p.beats - prev, true);
    dv.setFloat64(o + 8, p.value, true);
    dv.setFloat32(o + 16, p.tension ?? 0, true);
    prev = p.beats;
  });
  return data(E.channelAutomation, b);
}

/** One automation link record: automation channel → (param, destination). */
export function automationLinks(links: { channel: number; param: number; destination: number }[]): FlpEvent {
  const b = new Uint8Array(links.length * 20);
  const dv = new DataView(b.buffer);
  links.forEach((l, i) => {
    const o = i * 20;
    b[o + 2] = l.channel;
    dv.setUint16(o + 8, l.param, true);
    dv.setUint16(o + 10, l.destination, true);
  });
  return data(E.automationLinks, b);
}

export function mixerParams(items: { insert: number; slot?: number; id: number; value: number }[]): FlpEvent {
  const b = new Uint8Array(items.length * 12);
  const dv = new DataView(b.buffer);
  items.forEach((m, i) => {
    const o = i * 12;
    b[o + 4] = m.id;
    dv.setUint16(o + 6, ((m.insert & 0x7f) << 6) | ((m.slot ?? 0) & 0x3f), true);
    dv.setInt32(o + 8, m.value, true);
  });
  return data(E.mixerParams, b);
}

export function routing(targets: number[], count = 127): FlpEvent {
  const b = new Uint8Array(count);
  for (const t of targets) b[t] = 1;
  return data(E.insertRouting, b);
}

export function insertFlags(flags: number): FlpEvent {
  const b = new Uint8Array(12);
  new DataView(b.buffer).setUint32(4, flags, true);
  return data(E.insertFlags, b);
}

// --- A small project builder -------------------------------------------------------------------

export interface ChannelSpec {
  name?: string;
  /** FL internal name; '' = Sampler. */
  plugin?: string;
  vst?: string;
  type?: number;
  sample?: string;
  insert?: number;
  levels?: [pan: number, volume: number, pitch?: number];
  color?: number;
  root?: number;
  enabled?: boolean;
  children?: number[];
  automation?: { beats: number; value: number; tension?: number }[];
}

export interface PatternSpec {
  iid: number;
  name?: string;
  color?: number;
  notes?: NoteSpec[];
}

export interface InsertSpec {
  name?: string;
  color?: number;
  flags?: number;
  routes?: number[];
  slots?: { plugin: string; vst?: string; name?: string }[];
}

export interface ProjectSpec {
  version?: string;
  ppq?: number;
  title?: string;
  artist?: string;
  genre?: string;
  tempo?: number;
  /** Legacy tempo: coarse BPM word + fine thousandths. */
  legacyTempo?: [coarse: number, fine: number];
  timeSig?: [num: number, beat: number];
  channels?: ChannelSpec[];
  patterns?: PatternSpec[];
  arrangements?: {
    name?: string;
    items?: ItemSpec[];
    tracks?: { name?: string; color?: number; enabled?: boolean }[];
    markers?: { position: number; name?: string; signature?: [number, number] }[];
    stride?: number;
  }[];
  currentArrangement?: number;
  inserts?: InsertSpec[];
  params?: { insert: number; slot?: number; id: number; value: number }[];
  links?: { channel: number; param: number; destination: number }[];
  /** Write arrangement-less playlist events (FL before 12.9). */
  legacyPlaylist?: boolean;
}

/** Events for a whole project in FL's usual order. */
export function projectEvents(spec: ProjectSpec): FlpEvent[] {
  const version = spec.version ?? '21.2.3.4004';
  const parts = version.split('.').map(Number);
  const unicode = (parts[0] ?? 0) > 11 || ((parts[0] ?? 0) === 11 && (parts[1] ?? 0) >= 5);
  const t = (id: number, s: string) => text(id, s, unicode);
  const out: FlpEvent[] = [data(E.version, ascii(version))];
  if (spec.title) out.push(t(E.title, spec.title));
  if (spec.artist) out.push(t(E.artist, spec.artist));
  if (spec.genre) out.push(t(E.genre, spec.genre));
  if (spec.tempo !== undefined) out.push(ev(E.tempo, Math.round(spec.tempo * 1000)));
  if (spec.legacyTempo) out.push(ev(E.tempoCoarse, spec.legacyTempo[0]), ev(E.tempoFine, spec.legacyTempo[1]));
  // Patterns (notes) come before the channels in FL 12+ files.
  for (const p of spec.patterns ?? []) {
    out.push(ev(E.patternNew, p.iid));
    if (p.notes) out.push(notes(p.notes));
  }
  (spec.channels ?? []).forEach((c, i) => {
    out.push(ev(E.channelNew, i), ev(E.channelType, c.type ?? (c.plugin ? 2 : 0)));
    out.push(t(E.pluginInternalName, c.plugin ?? ''));
    if (c.color !== undefined) out.push(ev(E.pluginColor, c.color));
    if (c.vst) out.push(vstData(c.vst, 'Vendor'));
    if (c.name) out.push(t(E.pluginName, c.name));
    if (c.enabled === false) out.push(ev(E.channelEnabled, 0));
    if (c.levels) out.push(levels(c.levels[0], c.levels[1], c.levels[2]));
    if (c.root !== undefined) out.push(ev(E.channelRootNote, c.root));
    if (c.insert !== undefined) out.push(ev(E.channelRoutedTo, c.insert & 0xff));
    for (const k of c.children ?? []) out.push(ev(E.channelChild, k));
    if (c.sample) out.push(t(E.samplePath, c.sample));
    if (c.automation) out.push(automationPoints(c.automation));
  });
  if (spec.links) out.push(automationLinks(spec.links));
  // Pattern names and colours (the second PatternNew per pattern).
  for (const p of spec.patterns ?? []) {
    out.push(ev(E.patternNew, p.iid));
    if (p.name) out.push(t(E.patternName, p.name));
    if (p.color !== undefined) out.push(ev(E.patternColor, p.color));
  }
  if (spec.timeSig) out.push(ev(E.timeSigNum, spec.timeSig[0]), ev(E.timeSigBeat, spec.timeSig[1]));
  const maxTrack = (parts[0] ?? 0) > 12 || ((parts[0] ?? 0) === 12 && (parts[1] ?? 0) >= 9) ? 499 : 198;
  (spec.arrangements ?? []).forEach((a, i) => {
    if (!spec.legacyPlaylist) {
      out.push(ev(E.arrangementNew, i));
      if (a.name) out.push(t(E.arrangementName, a.name));
    }
    if (a.items) out.push(playlist(a.items, { maxTrack, ...(a.stride ? { stride: a.stride } : {}) }));
    for (const m of a.markers ?? []) {
      out.push(ev(E.markerPosition, m.signature ? m.position + 0x08000000 : m.position));
      if (m.name) out.push(t(E.markerName, m.name));
      if (m.signature) out.push(ev(E.markerNumerator, m.signature[0]), ev(E.markerDenominator, m.signature[1]));
    }
    (a.tracks ?? []).forEach((tr, ti) => {
      out.push(trackData(ti, tr));
      if (tr.name) out.push(t(E.trackName, tr.name));
    });
  });
  if (spec.currentArrangement !== undefined) out.push(ev(E.arrangementCurrent, spec.currentArrangement));
  (spec.inserts ?? []).forEach((ins) => {
    out.push(insertFlags(ins.flags ?? 0b1100));
    (ins.slots ?? []).forEach((s, si) => {
      out.push(t(E.pluginInternalName, s.plugin));
      if (s.vst) out.push(vstData(s.vst));
      if (s.name) out.push(t(E.pluginName, s.name));
      out.push(ev(E.slotIndex, si));
    });
    if (ins.name) out.push(t(E.insertName, ins.name));
    if (ins.color !== undefined) out.push(ev(E.insertColor, ins.color));
    out.push(routing(ins.routes ?? [0]), ev(E.insertInput, 0xffffffff), ev(E.insertOutput, 0));
  });
  if (spec.params) out.push(mixerParams(spec.params));
  return out;
}

export function flpProject(spec: ProjectSpec): Uint8Array {
  return flpFile(projectEvents(spec), { ppq: spec.ppq ?? 96, channels: spec.channels?.length ?? 0 });
}
