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

export class MidiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MidiError';
  }
}

class Reader {
  pos = 0;
  constructor(
    readonly b: Uint8Array,
    readonly end = b.length,
  ) {}
  u8(): number {
    if (this.pos >= this.end) throw new MidiError('The MIDI file ends unexpectedly.');
    return this.b[this.pos++]!;
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.u8();
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new MidiError('A MIDI time value is too long.');
  }
  text(n: number): string {
    const s = this.b.subarray(this.pos, Math.min(this.end, this.pos + n));
    this.pos += n;
    let out = '';
    for (const c of s) out += String.fromCharCode(c);
    return out;
  }
  skip(n: number): void {
    this.pos += n;
  }
}

export function parseMidi(bytes: Uint8Array): MidiFileData {
  const r = new Reader(bytes);
  if (r.text(4) !== 'MThd') throw new MidiError('This is not a MIDI file.');
  const headerLen = r.u32();
  const format = r.u16();
  const ntracks = r.u16();
  const division = r.u16();
  r.skip(headerLen - 6);
  let ppq: number;
  let scale: number;
  if (division & 0x8000) {
    // SMPTE: frames per second × ticks per frame; read as if at 120 BPM.
    const fps = 256 - (division >> 8);
    const tpf = division & 0xff;
    ppq = (fps * tpf) / 2;
    scale = PPQ / ppq;
  } else {
    ppq = division || 96;
    scale = PPQ / ppq;
  }
  const tracks: MidiTrack[] = [];
  const tempos: { tick: number; bpm: number }[] = [];
  let timeSig: MidiFileData['timeSig'] = null;
  for (let t = 0; t < ntracks && r.pos + 8 <= bytes.length; t++) {
    const id = r.text(4);
    const len = r.u32();
    const end = Math.min(bytes.length, r.pos + len);
    if (id !== 'MTrk') {
      r.pos = end;
      continue;
    }
    const tr = new Reader(bytes, end);
    tr.pos = r.pos;
    const track: MidiTrack = { name: '', notes: [], programs: {} };
    const open = new Map<number, { tick: number; velocity: number }[]>();
    let tick = 0;
    let status = 0;
    const close = (ch: number, key: number, at: number) => {
      const list = open.get(ch * 128 + key);
      const on = list?.shift();
      if (!on) return;
      track.notes.push({
        tick: Math.round(on.tick * scale),
        length: Math.max(1, Math.round((at - on.tick) * scale)),
        key,
        velocity: on.velocity,
        channel: ch,
      });
    };
    while (tr.pos < end) {
      tick += tr.vlq();
      const b = tr.u8();
      if (b === 0xff) {
        const type = tr.u8();
        const n = tr.vlq();
        const at = tr.pos;
        if (type === 0x2f) break;
        if (type === 0x03 && !track.name) track.name = tr.text(n).replace(/\0+$/, '').trim();
        else if (type === 0x51 && n >= 3) {
          const us = (tr.u8() << 16) | (tr.u8() << 8) | tr.u8();
          if (us > 0) tempos.push({ tick: Math.round(tick * scale), bpm: Math.round((60_000_000 / us) * 1000) / 1000 });
        } else if (type === 0x58 && n >= 2 && !timeSig) {
          const num = tr.u8();
          const den = 2 ** tr.u8();
          if (num >= 1 && num <= 32 && [1, 2, 4, 8, 16, 32].includes(den)) timeSig = { num, den };
        }
        tr.pos = at + n;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        tr.skip(tr.vlq());
        continue;
      }
      if (b & 0x80) status = b;
      else {
        // Running status: this byte is the first data byte.
        if (!status) throw new MidiError('The MIDI file has data without a status byte.');
        tr.pos--;
      }
      const kind = status & 0xf0;
      const ch = status & 0x0f;
      if (kind === 0x80 || kind === 0x90) {
        const key = tr.u8() & 0x7f;
        const vel = tr.u8() & 0x7f;
        if (kind === 0x90 && vel > 0) {
          const k = ch * 128 + key;
          const list = open.get(k) ?? [];
          list.push({ tick, velocity: vel / 127 });
          open.set(k, list);
        } else close(ch, key, tick);
      } else if (kind === 0xa0 || kind === 0xb0 || kind === 0xe0) tr.skip(2);
      else if (kind === 0xc0) {
        const program = tr.u8() & 0x7f;
        if (track.programs[ch] === undefined) track.programs[ch] = program;
      } else if (kind === 0xd0) tr.skip(1);
    }
    // Notes never released end at the track's end.
    for (const [k, list] of open) while (list.length > 0) close(Math.floor(k / 128), k % 128, tick);
    track.notes.sort((a, b) => a.tick - b.tick || a.key - b.key);
    tracks.push(track);
    r.pos = end;
  }
  tempos.sort((a, b) => a.tick - b.tick);
  return { format, ppq, tracks, tempos, timeSig };
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

function vlq(n: number, out: number[]): void {
  let v = Math.max(0, Math.round(n));
  const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) bytes.unshift((v & 0x7f) | 0x80);
  out.push(...bytes);
}

function chunk(id: string, body: number[]): number[] {
  const len = body.length;
  return [...id]
    .map((c) => c.charCodeAt(0))
    .concat([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255], body);
}

function textMeta(type: number, text: string, out: number[]): void {
  // Latin-1 (what most MIDI tools read); other characters become "?".
  const bytes = [...text].map((c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f));
  out.push(0, 0xff, type);
  vlq(bytes.length, out);
  out.push(...bytes);
}

/** A format-1 file at PPQ 960: a conductor track (name, tempo, time signature) and one track per part. */
export function writeMidi(song: {
  name: string;
  bpm: number;
  timeSig: { num: number; den: number };
  tracks: readonly MidiWriteTrack[];
}): Uint8Array {
  const conductor: number[] = [];
  textMeta(0x03, song.name, conductor);
  const us = Math.round(60_000_000 / Math.max(1, song.bpm));
  conductor.push(0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255);
  conductor.push(0, 0xff, 0x58, 4, song.timeSig.num, Math.round(Math.log2(song.timeSig.den)), 24, 8);
  conductor.push(0, 0xff, 0x2f, 0);
  const chunks = [chunk('MThd', [0, 1, 0, song.tracks.length + 1, PPQ >> 8, PPQ & 255]), chunk('MTrk', conductor)];
  for (const t of song.tracks) {
    const body: number[] = [];
    textMeta(0x03, t.name, body);
    const ch = Math.max(0, Math.min(15, t.channel));
    if (t.program !== undefined) body.push(0, 0xc0 | ch, Math.max(0, Math.min(127, t.program)));
    const events: { tick: number; on: boolean; key: number; vel: number }[] = [];
    for (const n of t.notes) {
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
      events.push({ tick: Math.round(n.tick), on: true, key: n.key, vel });
      events.push({ tick: Math.round(n.tick + n.length), on: false, key: n.key, vel: 64 });
    }
    // Note-offs before note-ons at the same tick, so repeated notes don't cut themselves off.
    events.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on));
    let last = 0;
    for (const e of events) {
      vlq(e.tick - last, body);
      last = e.tick;
      body.push((e.on ? 0x90 : 0x80) | ch, e.key & 0x7f, e.vel);
    }
    body.push(0, 0xff, 0x2f, 0);
    chunks.push(chunk('MTrk', body));
  }
  return Uint8Array.from(chunks.flat());
}
