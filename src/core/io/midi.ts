/**
 * Standard MIDI Files (.mid): parse formats 0 and 1 (2 is read like 1) and write format 1.
 * Ticks are rescaled to AGstudio's PPQ (960). Notes pair first-in-first-out per channel and key, so
 * overlapping notes of the same key end in the order they started.
 */
import { PPQ } from '../time/ppq';

export interface MidiNote {
  /** Start in ticks at PPQ 960. */
  tick: number;
  length: number;
  key: number;
  /** 0–1. */
  velocity: number;
  /** MIDI channel 0–15 (9 is GM drums). */
  channel: number;
}

export interface MidiTrack {
  name: string;
  notes: MidiNote[];
  /** Program changes (GM instrument numbers 0–127) by channel, first one wins. */
  programs: Partial<Record<number, number>>;
}

export interface MidiFileData {
  format: number;
  /** The file's own ticks per quarter note (SMPTE files are converted assuming 120 BPM). */
  ppq: number;
  tracks: MidiTrack[];
  /** Tempo changes (ticks at PPQ 960), sorted; empty means 120 BPM. */
  tempos: { tick: number; bpm: number }[];
  timeSig: { num: number; den: number } | null;
}

/** Thrown for a file that is not valid MIDI, with a message fit to show the musician. */
export class MidiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MidiError';
  }
}

// --- File layout (Standard MIDI File spec, "MIDI 1.0 Detailed Specification") --------------------

const HEADER_CHUNK_ID = 'MThd';
const TRACK_CHUNK_ID = 'MTrk';
/** The header chunk holds format, track count and division: 6 bytes. */
const HEADER_BODY_BYTES = 6;
/** A chunk starts with a 4-byte id and a 4-byte length. */
const CHUNK_HEADER_BYTES = 8;
const DEFAULT_PPQ = 96;
/** The division's top bit selects SMPTE time (frames per second × ticks per frame) instead of ticks per beat. */
const DIVISION_SMPTE_FLAG = 0x8000;

/** Status bytes. Channel messages carry the channel in the low 4 bits. */
const STATUS_META_EVENT = 0xff;
const STATUS_SYSEX = 0xf0;
const STATUS_SYSEX_CONTINUATION = 0xf7;
const MESSAGE_NOTE_OFF = 0x80;
const MESSAGE_NOTE_ON = 0x90;
const MESSAGE_POLY_PRESSURE = 0xa0;
const MESSAGE_CONTROL_CHANGE = 0xb0;
const MESSAGE_PROGRAM_CHANGE = 0xc0;
const MESSAGE_CHANNEL_PRESSURE = 0xd0;
const MESSAGE_PITCH_BEND = 0xe0;

/** Meta event types. */
const META_TRACK_NAME = 0x03;
const META_END_OF_TRACK = 0x2f;
const META_SET_TEMPO = 0x51;
const META_TIME_SIGNATURE = 0x58;

const MICROSECONDS_PER_MINUTE = 60_000_000;
/** Time signature denominators are stored as powers of two; these are the note values we accept. */
const TIME_SIGNATURE_DENOMINATORS = [1, 2, 4, 8, 16, 32];
const TIME_SIGNATURE_NUMERATOR_MAX = 32;
/** A variable-length quantity is at most 4 bytes of 7 bits. */
const VLQ_MAX_BYTES = 4;
const KEYS_PER_CHANNEL = 128;
const MAX_VELOCITY = 127;

/** Reads bytes in order; throws a MidiError when the file ends early. */
class MidiReader {
  pos = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly end = bytes.length,
  ) {}
  u8(): number {
    if (this.pos >= this.end) throw new MidiError('The MIDI file ends unexpectedly.');
    return this.bytes[this.pos++]!;
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  /** A variable-length quantity: 7 bits per byte, the top bit says another byte follows. */
  vlq(): number {
    let value = 0;
    for (let i = 0; i < VLQ_MAX_BYTES; i++) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new MidiError('A MIDI time value is too long.');
  }
  /** `length` bytes as Latin-1 text (a position past the end is clipped, but the position still advances). */
  text(length: number): string {
    const slice = this.bytes.subarray(this.pos, Math.min(this.end, this.pos + length));
    this.pos += length;
    let out = '';
    for (const byte of slice) out += String.fromCharCode(byte);
    return out;
  }
  skip(length: number): void {
    this.pos += length;
  }
}

/** What the header says about timing: the file's ticks per beat, and the factor to AGstudio's PPQ. */
interface Timing {
  ppq: number;
  /** Multiply file ticks by this to get ticks at PPQ 960. */
  scale: number;
}

/** Tempo and time signature changes found in any track (they apply to the whole song). */
interface SongSettings {
  tempos: { tick: number; bpm: number }[];
  timeSig: MidiFileData['timeSig'];
}

/** Parses a Standard MIDI File (format 0, 1 or 2). Throws MidiError for data that is not one. */
export function parseMidi(bytes: Uint8Array): MidiFileData {
  const reader = new MidiReader(bytes);
  if (reader.text(4) !== HEADER_CHUNK_ID) throw new MidiError('This is not a MIDI file.');
  const headerLength = reader.u32();
  const format = reader.u16();
  const trackCount = reader.u16();
  const division = reader.u16();
  reader.skip(headerLength - HEADER_BODY_BYTES);
  const timing = timingFromDivision(division);

  const tracks: MidiTrack[] = [];
  const settings: SongSettings = { tempos: [], timeSig: null };
  for (let t = 0; t < trackCount && reader.pos + CHUNK_HEADER_BYTES <= bytes.length; t++) {
    const chunkId = reader.text(4);
    const chunkLength = reader.u32();
    const end = Math.min(bytes.length, reader.pos + chunkLength);
    if (chunkId === TRACK_CHUNK_ID) {
      const trackReader = new MidiReader(bytes, end);
      trackReader.pos = reader.pos;
      tracks.push(readTrack(trackReader, end, timing.scale, settings));
    }
    reader.pos = end;
  }
  settings.tempos.sort((a, b) => a.tick - b.tick);
  return { format, ppq: timing.ppq, tracks, tempos: settings.tempos, timeSig: settings.timeSig };
}

function timingFromDivision(division: number): Timing {
  if (division & DIVISION_SMPTE_FLAG) {
    // SMPTE: frames per second × ticks per frame; read as if at 120 BPM.
    const framesPerSecond = 256 - (division >> 8);
    const ticksPerFrame = division & 0xff;
    const ppq = (framesPerSecond * ticksPerFrame) / 2;
    return { ppq, scale: PPQ / ppq };
  }
  const ppq = division || DEFAULT_PPQ;
  return { ppq, scale: PPQ / ppq };
}

/** A note that has started and is waiting for its note-off. */
interface OpenNote {
  tick: number;
  velocity: number;
}

/** Reads the events of one track chunk (up to `end`), adding tempo and time signature changes to `settings`. */
function readTrack(reader: MidiReader, end: number, scale: number, settings: SongSettings): MidiTrack {
  const track: MidiTrack = { name: '', notes: [], programs: {} };
  /** Started notes by channel and key, in the order they started (first in, first out). */
  const openNotes = new Map<number, OpenNote[]>();
  const finishNote = (channel: number, key: number, endTick: number) => {
    const started = openNotes.get(channel * KEYS_PER_CHANNEL + key)?.shift();
    if (!started) return;
    track.notes.push({
      tick: Math.round(started.tick * scale),
      length: Math.max(1, Math.round((endTick - started.tick) * scale)),
      key,
      velocity: started.velocity,
      channel,
    });
  };

  let tick = 0;
  let runningStatus = 0;
  while (reader.pos < end) {
    tick += reader.vlq();
    const firstByte = reader.u8();
    if (firstByte === STATUS_META_EVENT) {
      if (readMetaEvent(reader, track, tick, scale, settings) === 'end-of-track') break;
      continue;
    }
    if (firstByte === STATUS_SYSEX || firstByte === STATUS_SYSEX_CONTINUATION) {
      reader.skip(reader.vlq());
      continue;
    }
    if (firstByte & 0x80) {
      runningStatus = firstByte;
    } else {
      // Running status: this byte is the first data byte of a message with the previous status.
      if (!runningStatus) throw new MidiError('The MIDI file has data without a status byte.');
      reader.pos--;
    }
    readChannelMessage(reader, runningStatus, tick, track, openNotes, finishNote);
  }
  // Notes never released end at the track's end.
  for (const [mapKey, started] of openNotes) {
    while (started.length > 0) finishNote(Math.floor(mapKey / KEYS_PER_CHANNEL), mapKey % KEYS_PER_CHANNEL, tick);
  }
  track.notes.sort((a, b) => a.tick - b.tick || a.key - b.key);
  return track;
}

/** Reads a meta event (the 0xFF byte is already read). Returns 'end-of-track' when the track is over. */
function readMetaEvent(
  reader: MidiReader,
  track: MidiTrack,
  tick: number,
  scale: number,
  settings: SongSettings,
): 'end-of-track' | 'continue' {
  const type = reader.u8();
  const length = reader.vlq();
  const dataStart = reader.pos;
  if (type === META_END_OF_TRACK) return 'end-of-track';
  if (type === META_TRACK_NAME && !track.name) {
    track.name = reader.text(length).replace(/\0+$/, '').trim();
  } else if (type === META_SET_TEMPO && length >= 3) {
    const microsecondsPerBeat = (reader.u8() << 16) | (reader.u8() << 8) | reader.u8();
    if (microsecondsPerBeat > 0) {
      const bpm = Math.round((MICROSECONDS_PER_MINUTE / microsecondsPerBeat) * 1000) / 1000;
      settings.tempos.push({ tick: Math.round(tick * scale), bpm });
    }
  } else if (type === META_TIME_SIGNATURE && length >= 2 && !settings.timeSig) {
    const num = reader.u8();
    const den = 2 ** reader.u8();
    if (num >= 1 && num <= TIME_SIGNATURE_NUMERATOR_MAX && TIME_SIGNATURE_DENOMINATORS.includes(den)) {
      settings.timeSig = { num, den };
    }
  }
  reader.pos = dataStart + length;
  return 'continue';
}

/** Reads the data bytes of a channel message with the given status (note on/off, program change, others skipped). */
function readChannelMessage(
  reader: MidiReader,
  status: number,
  tick: number,
  track: MidiTrack,
  openNotes: Map<number, OpenNote[]>,
  finishNote: (channel: number, key: number, endTick: number) => void,
): void {
  const message = status & 0xf0;
  const channel = status & 0x0f;
  if (message === MESSAGE_NOTE_OFF || message === MESSAGE_NOTE_ON) {
    const key = reader.u8() & 0x7f;
    const velocity = reader.u8() & 0x7f;
    // A note-on with velocity 0 is a note-off.
    if (message === MESSAGE_NOTE_ON && velocity > 0) {
      const mapKey = channel * KEYS_PER_CHANNEL + key;
      const started = openNotes.get(mapKey) ?? [];
      started.push({ tick, velocity: velocity / MAX_VELOCITY });
      openNotes.set(mapKey, started);
    } else {
      finishNote(channel, key, tick);
    }
  } else if (
    message === MESSAGE_POLY_PRESSURE ||
    message === MESSAGE_CONTROL_CHANGE ||
    message === MESSAGE_PITCH_BEND
  ) {
    reader.skip(2);
  } else if (message === MESSAGE_PROGRAM_CHANGE) {
    const program = reader.u8() & 0x7f;
    if (track.programs[channel] === undefined) track.programs[channel] = program;
  } else if (message === MESSAGE_CHANNEL_PRESSURE) {
    reader.skip(1);
  }
}

// ---------------------------------------------------------------------------------------------
// Writing

export interface MidiWriteTrack {
  name: string;
  channel: number;
  program?: number;
  /** Ticks at PPQ 960. */
  notes: readonly { tick: number; length: number; key: number; velocity: number }[];
}

/** Appends `n` as a variable-length quantity. */
function writeVlq(n: number, out: number[]): void {
  let value = Math.max(0, Math.round(n));
  const bytes = [value & 0x7f];
  while ((value >>= 7) > 0) bytes.unshift((value & 0x7f) | 0x80);
  out.push(...bytes);
}

/** A chunk: its id, a 4-byte big-endian length, then the body. */
function chunk(id: string, body: number[]): number[] {
  const length = body.length;
  return [...id]
    .map((c) => c.charCodeAt(0))
    .concat([(length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255], body);
}

function writeTextMeta(type: number, text: string, out: number[]): void {
  // Latin-1 (what most MIDI tools read); other characters become "?".
  const bytes = [...text].map((c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f));
  out.push(0, STATUS_META_EVENT, type);
  writeVlq(bytes.length, out);
  out.push(...bytes);
}

/** The conductor track: song name, tempo and time signature. */
function conductorTrack(song: { name: string; bpm: number; timeSig: { num: number; den: number } }): number[] {
  const body: number[] = [];
  writeTextMeta(META_TRACK_NAME, song.name, body);
  const microsecondsPerBeat = Math.round(MICROSECONDS_PER_MINUTE / Math.max(1, song.bpm));
  body.push(
    0,
    STATUS_META_EVENT,
    META_SET_TEMPO,
    3,
    (microsecondsPerBeat >> 16) & 255,
    (microsecondsPerBeat >> 8) & 255,
    microsecondsPerBeat & 255,
  );
  // Time signature: numerator, log2 of the denominator, 24 clocks per click, 8 thirty-seconds per quarter.
  body.push(
    0,
    STATUS_META_EVENT,
    META_TIME_SIGNATURE,
    4,
    song.timeSig.num,
    Math.round(Math.log2(song.timeSig.den)),
    24,
    8,
  );
  body.push(0, STATUS_META_EVENT, META_END_OF_TRACK, 0);
  return body;
}

/** One part: its name, an optional program change, then its notes as paired on and off events. */
function partTrack(part: MidiWriteTrack): number[] {
  const body: number[] = [];
  writeTextMeta(META_TRACK_NAME, part.name, body);
  const channel = Math.max(0, Math.min(15, part.channel));
  if (part.program !== undefined) {
    body.push(0, MESSAGE_PROGRAM_CHANGE | channel, Math.max(0, Math.min(127, part.program)));
  }
  const events: { tick: number; isOn: boolean; key: number; velocity: number }[] = [];
  for (const note of part.notes) {
    const velocity = Math.max(1, Math.min(MAX_VELOCITY, Math.round(note.velocity * MAX_VELOCITY)));
    events.push({ tick: Math.round(note.tick), isOn: true, key: note.key, velocity });
    events.push({ tick: Math.round(note.tick + note.length), isOn: false, key: note.key, velocity: 64 });
  }
  // Note-offs before note-ons at the same tick, so repeated notes don't cut themselves off.
  events.sort((a, b) => a.tick - b.tick || Number(a.isOn) - Number(b.isOn));
  let previousTick = 0;
  for (const event of events) {
    writeVlq(event.tick - previousTick, body);
    previousTick = event.tick;
    body.push((event.isOn ? MESSAGE_NOTE_ON : MESSAGE_NOTE_OFF) | channel, event.key & 0x7f, event.velocity);
  }
  body.push(0, STATUS_META_EVENT, META_END_OF_TRACK, 0);
  return body;
}

/** A format-1 file at PPQ 960: a conductor track (name, tempo, time signature) and one track per part. */
export function writeMidi(song: {
  name: string;
  bpm: number;
  timeSig: { num: number; den: number };
  tracks: readonly MidiWriteTrack[];
}): Uint8Array {
  const format = 1;
  const header = [0, format, 0, song.tracks.length + 1, PPQ >> 8, PPQ & 255];
  const chunks = [chunk(HEADER_CHUNK_ID, header), chunk(TRACK_CHUNK_ID, conductorTrack(song))];
  for (const part of song.tracks) chunks.push(chunk(TRACK_CHUNK_ID, partTrack(part)));
  return Uint8Array.from(chunks.flat());
}
