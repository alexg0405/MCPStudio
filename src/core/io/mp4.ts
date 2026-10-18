/**
 * A small MP4 (ISO base media) muxer for one H.264 video track and one AAC track, written for
 * streaming with the index at the front ("faststart"): the file begins with `ftyp`, then the `moov`
 * box, then `mdat` with the samples, so a player can start before the whole file has arrived.
 *
 * The `moov` can only be written when the last sample is known, so its space is reserved up front:
 * the muxer is told the longest the video can be (`maxSeconds`), computes the largest `moov` such a
 * file can need, writes a `free` box of that size, streams the samples after it, and at the end
 * writes the real `moov` over the start of the reservation and a `free` box over what is left.
 * Samples go out in groups of about half a second (one chunk per track per group), video then audio.
 *
 * AAC's priming (the first 2112 samples are the encoder's warm-up) is cut with an edit list, so the
 * sound lines up with the picture. Frames must arrive in presentation order (no B-frame reordering).
 *
 * Pure bytes through a `MuxWriter`: no DOM; the tests read the box tree back.
 */
import type { MuxChunk, MuxWriter } from './webm';

export class Mp4Error extends Error {}

export interface Mp4VideoTrack {
  width: number;
  height: number;
  fps: number;
  /** The `avcC` record (the encoder's description). */
  avcC: Uint8Array;
}

export interface Mp4AudioTrack {
  channels: number;
  sampleRate: number;
  /** The AudioSpecificConfig (the encoder's description). */
  audioSpecificConfig: Uint8Array;
  /** Samples at the start of the stream that belong to the encoder, not the music (cut by an edit list). */
  priming: number;
}

export interface Mp4Options {
  video: Mp4VideoTrack;
  audio?: Mp4AudioTrack | undefined;
  /** The longest the file can be, in seconds: sizes the space reserved for the index. */
  maxSeconds: number;
  /** Seconds between key frames the encoder uses (sizes the sync-sample table; twice as many are allowed). */
  keyFrameSeconds: number;
  /** Samples are grouped into chunks of about this many milliseconds (default 500). */
  groupMs?: number;
}

/** AAC-LC frames are 1024 samples. */
export const AAC_FRAME = 1024;
/** The encoder's warm-up for AAC-LC (what Apple's and most encoders use). */
export const AAC_PRIMING = 2112;
/** Video media timescale: 90 kHz. */
const VIDEO_TIMESCALE = 90000;
const MOVIE_TIMESCALE = 1000;
/** An MP4 with 32-bit sizes and offsets stays under this. */
const MAX_BYTES = 4_000_000_000;

// ---------------------------------------------------------------- box writing

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u8 = (...v: number[]) => Uint8Array.from(v);
const u16 = (v: number) => u8((v >>> 8) & 0xff, v & 0xff);
const u32 = (v: number) => u8((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
const zeros = (n: number) => new Uint8Array(n);

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(8 + body.length), ascii(type), body]);
}

/** A full box: version byte and 24 bits of flags first. */
function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, u8(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff), ...payload);
}

/** The 3×3 identity matrix every tkhd and mvhd carries. */
const MATRIX = concat([
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
]);

/** An MPEG-4 descriptor: tag, a length in one byte (all ours are short), the payload. */
function descriptor(tag: number, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  if (body.length > 127) throw new Mp4Error('The audio configuration is too long for an MP4 file.');
  return concat([u8(tag, body.length), body]);
}

// ---------------------------------------------------------------- sample tables

/** What the index is made of for one track. Arrays grow as samples are written. */
interface TrackTable {
  /** Bytes of each sample. */
  sizes: number[];
  /** Media-time delta of each sample, in the track's timescale, run-length encoded. */
  durations: Array<[count: number, delta: number]>;
  /** 1-based numbers of the key frames (video). */
  syncs: number[];
  /** Offsets from the start of the sample data of each chunk, and how many samples it holds. */
  chunkOffsets: number[];
  chunkSamples: number[];
  /** Total media time, in the track's timescale. */
  duration: number;
}

const newTable = (): TrackTable => ({
  sizes: [],
  durations: [],
  syncs: [],
  chunkOffsets: [],
  chunkSamples: [],
  duration: 0,
});

function pushDuration(t: TrackTable, delta: number): void {
  const last = t.durations[t.durations.length - 1];
  if (last && last[1] === delta) last[0]++;
  else t.durations.push([1, delta]);
  t.duration += delta;
}

/** stsc entries: a new entry whenever the samples per chunk change. */
function chunkRuns(t: TrackTable): Array<[firstChunk: number, perChunk: number]> {
  const runs: Array<[number, number]> = [];
  t.chunkSamples.forEach((n, i) => {
    const last = runs[runs.length - 1];
    if (!last || last[1] !== n) runs.push([i + 1, n]);
  });
  return runs;
}

/** Big-endian 32-bit words (tables run to hundreds of thousands of entries: no spreading into argument lists). */
function words(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(4 * values.length);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) dv.setUint32(4 * i, values[i] as number);
  return out;
}

function sampleTableBoxes(t: TrackTable, base: number, withSyncs: boolean): Uint8Array[] {
  const stts = fullBox('stts', 0, 0, u32(t.durations.length), words(t.durations.flat()));
  const stss = withSyncs ? fullBox('stss', 0, 0, u32(t.syncs.length), words(t.syncs)) : null;
  const runs = chunkRuns(t);
  const stsc = fullBox('stsc', 0, 0, u32(runs.length), words(runs.flatMap(([first, n]) => [first, n, 1])));
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(t.sizes.length), words(t.sizes));
  const stco = fullBox('stco', 0, 0, u32(t.chunkOffsets.length), words(t.chunkOffsets.map((o) => base + o)));
  return [stts, ...(stss ? [stss] : []), stsc, stsz, stco];
}

// ---------------------------------------------------------------- the moov box

/** mdhd `language`: "und" (undetermined) as three 5-bit letters, each letter minus 0x60. */
const LANGUAGE_UNDETERMINED = 0x55c4;
/** tkhd `flags`: track enabled (1) and in the movie (2). */
const TRACK_ENABLED_IN_MOVIE = 3;
/** tkhd `volume` of an audio track: 8.8 fixed point 1.0. */
const FIXED_8_8_ONE = 0x0100;
/** mvhd `rate`: 16.16 fixed point 1.0. */
const FIXED_16_16_ONE = 0x00010000;
/** Visual sample entry `horizresolution` and `vertresolution`: 72 dpi in 16.16 fixed point. */
const DPI_72 = 0x00480000;
/** Visual sample entry `depth`: 24-bit colour with no alpha. */
const DEPTH_COLOR = 0x0018;
/** esds (ISO/IEC 14496-1): decoder config object type 0x40 (MPEG-4 audio) and stream type 5 (audio) as 0x15. */
const ESDS_OBJECT_TYPE_AAC = 0x40;
const ESDS_STREAM_TYPE_AUDIO = 0x15;
/** Bits per sample written in the audio sample entry (AAC has no real bit depth; players ignore it). */
const AUDIO_SAMPLE_SIZE_BITS = 16;

const handler = (type: string, name: string) =>
  fullBox('hdlr', 0, 0, u32(0), ascii(type), zeros(12), concat([ascii(name), u8(0)]));

const dinf = () => box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));

function mdhd(timescale: number, duration: number): Uint8Array {
  // Language "und" packed as three 5-bit letters.
  return fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(LANGUAGE_UNDETERMINED), u16(0));
}

function tkhd(id: number, duration: number, audio: boolean, width: number, height: number): Uint8Array {
  return fullBox(
    'tkhd',
    0,
    TRACK_ENABLED_IN_MOVIE,
    u32(0),
    u32(0),
    u32(id),
    u32(0),
    u32(duration),
    zeros(8),
    u16(0),
    u16(0),
    u16(audio ? FIXED_8_8_ONE : 0),
    u16(0),
    MATRIX,
    u32(width * 65536),
    u32(height * 65536),
  );
}

function videoEntry(v: Mp4VideoTrack): Uint8Array {
  return box(
    'avc1',
    zeros(6),
    u16(1),
    zeros(16),
    u16(v.width),
    u16(v.height),
    u32(DPI_72),
    u32(DPI_72),
    u32(0),
    u16(1),
    zeros(32),
    u16(DEPTH_COLOR),
    u16(0xffff), // pre_defined (-1)
    box('avcC', v.avcC),
  );
}

function audioEntry(a: Mp4AudioTrack): Uint8Array {
  const esds = fullBox(
    'esds',
    0,
    0,
    descriptor(
      0x03,
      u16(2),
      u8(0),
      descriptor(
        0x04,
        u8(ESDS_OBJECT_TYPE_AAC, ESDS_STREAM_TYPE_AUDIO),
        u8(0, 0, 0),
        u32(0),
        u32(0),
        descriptor(0x05, a.audioSpecificConfig),
      ),
      descriptor(0x06, u8(2)),
    ),
  );
  return box(
    'mp4a',
    zeros(6),
    u16(1),
    zeros(8),
    u16(a.channels),
    u16(AUDIO_SAMPLE_SIZE_BITS),
    u16(0),
    u16(0),
    u32((Math.min(65535, a.sampleRate) << 16) >>> 0),
    esds,
  );
}

interface MoovInput {
  video: Mp4VideoTrack;
  videoTable: TrackTable;
  audio?: Mp4AudioTrack | undefined;
  audioTable?: TrackTable;
  /** Absolute file offset of the first sample byte. */
  base: number;
  /** Samples of real audio the encoder was given: the music ends there, not at the end of the last (padded) packet. */
  audioFrames?: number | undefined;
}

/** The movie box for what has been written (also used, with worst-case tables, to size the reservation). */
export function buildMoov(m: MoovInput): Uint8Array {
  const videoMs = Math.round((m.videoTable.duration * MOVIE_TIMESCALE) / VIDEO_TIMESCALE);
  const traks: Uint8Array[] = [videoTrack(m, videoMs)];
  let audioMs = 0;
  if (m.audio && m.audioTable) {
    const audio = audioTrack(m, m.audio, m.audioTable);
    audioMs = audio.durationMs;
    traks.push(audio.trak);
  }
  return box('moov', movieHeader(Math.max(videoMs, audioMs), m.audio !== undefined), ...traks);
}

/** The video `trak`: header, media header, handler and the sample tables with their key frames. */
function videoTrack(m: MoovInput, durationMs: number): Uint8Array {
  return box(
    'trak',
    tkhd(1, durationMs, false, m.video.width, m.video.height),
    box(
      'mdia',
      mdhd(VIDEO_TIMESCALE, m.videoTable.duration),
      handler('vide', 'AGstudio video'),
      box(
        'minf',
        fullBox('vmhd', 0, 1, zeros(8)),
        dinf(),
        box(
          'stbl',
          fullBox('stsd', 0, 0, u32(1), videoEntry(m.video)),
          ...sampleTableBoxes(m.videoTable, m.base, true),
        ),
      ),
    ),
  );
}

/** The audio `trak` and how long its music lasts (the edit list drops the encoder's priming and padding). */
function audioTrack(m: MoovInput, audio: Mp4AudioTrack, table: TrackTable): { trak: Uint8Array; durationMs: number } {
  const music = Math.min(Math.max(0, table.duration - audio.priming), m.audioFrames ?? Infinity);
  const durationMs = Math.round((music * MOVIE_TIMESCALE) / audio.sampleRate);
  const trak = box(
    'trak',
    tkhd(2, durationMs, true, 0, 0),
    // The edit list drops the encoder's priming from the start.
    box('edts', fullBox('elst', 0, 0, u32(1), u32(durationMs), u32(audio.priming), u16(1), u16(0))),
    box(
      'mdia',
      mdhd(audio.sampleRate, table.duration),
      handler('soun', 'AGstudio audio'),
      box(
        'minf',
        fullBox('smhd', 0, 0, zeros(4)),
        dinf(),
        box('stbl', fullBox('stsd', 0, 0, u32(1), audioEntry(audio)), ...sampleTableBoxes(table, m.base, false)),
      ),
    ),
  );
  return { trak, durationMs };
}

/** The movie header: the movie's timescale and duration, rate 1.0, volume 1.0, and the next free track id. */
function movieHeader(durationMs: number, hasAudio: boolean): Uint8Array {
  return fullBox(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(MOVIE_TIMESCALE),
    u32(durationMs),
    u32(FIXED_16_16_ONE),
    u16(FIXED_8_8_ONE),
    zeros(10),
    MATRIX,
    zeros(24),
    u32(hasAudio ? 3 : 2),
  );
}

/** A table with `n` samples in `chunks` chunks and `keys` key frames: the biggest index a file of that size can have. */
function worstTable(samples: number, chunks: number, keys: number): TrackTable {
  const t = newTable();
  t.sizes = new Array<number>(samples).fill(0);
  // Every sample its own run is the widest the time-to-sample table can get; real files have a handful.
  t.durations = Array.from({ length: 16 }, (_, i) => [i === 15 ? samples : 1, i + 1] as [number, number]);
  t.syncs = new Array<number>(keys).fill(1);
  t.chunkOffsets = new Array<number>(chunks).fill(0);
  // Alternating counts: a new stsc entry for every chunk.
  t.chunkSamples = Array.from({ length: chunks }, (_, i) => 1 + (i % 2));
  return t;
}

/** Bytes the largest `moov` of a file up to `maxSeconds` long can take. */
export function reservedMoovSize(o: Mp4Options): number {
  const groupMs = o.groupMs ?? 500;
  const chunks = Math.ceil((o.maxSeconds * 1000) / groupMs) + 4;
  const videoSamples = Math.ceil(o.maxSeconds * o.video.fps) + Math.ceil(o.video.fps);
  const keys = Math.ceil(o.maxSeconds / Math.max(0.1, o.keyFrameSeconds)) * 2 + 2;
  const audioSamples = o.audio ? Math.ceil((o.maxSeconds * o.audio.sampleRate) / AAC_FRAME) + 4 : 0;
  const moov = buildMoov({
    video: o.video,
    videoTable: worstTable(videoSamples, chunks, keys),
    ...(o.audio ? { audio: o.audio, audioTable: worstTable(audioSamples, chunks, 0) } : {}),
    base: 0,
  });
  // 16 bytes over, so what is left after the real moov always has room for a `free` box header.
  return moov.length + 16;
}

// ---------------------------------------------------------------- the muxer

interface Group {
  startMs: number;
  video: Uint8Array[];
  videoSamples: number;
  videoBytes: number;
  audio: Uint8Array[];
  audioSamples: number;
  audioBytes: number;
}

export class Mp4Muxer {
  private pos = 0;
  private readonly reserved: number;
  private readonly ftyp: Uint8Array;
  /** Where the `moov` goes (right after ftyp) and where `mdat`'s header and data begin. */
  private readonly moovAt: number;
  private readonly mdatAt: number;
  private readonly dataAt: number;
  private dataBytes = 0;
  private readonly vt = newTable();
  private readonly at = newTable();
  private group: Group | null = null;
  private readonly vq: MuxChunk[] = [];
  private readonly aq: MuxChunk[] = [];
  private vEnded = false;
  private aEnded = false;
  private finished = false;
  private lastVideoTicks = -1;
  private lastVideoDuration = 0;
  private readonly groupMs: number;
  /** Bytes of the finished file. */
  size = 0;

  constructor(
    private readonly out: MuxWriter,
    private readonly opts: Mp4Options,
  ) {
    this.groupMs = opts.groupMs ?? 500;
    this.ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
    this.reserved = reservedMoovSize(opts);
    this.moovAt = this.ftyp.length;
    this.mdatAt = this.moovAt + this.reserved;
    this.dataAt = this.mdatAt + 8;
    this.emit(this.ftyp);
    // The index's space, as a free box for now (a file cut short is still a valid, empty-looking MP4).
    this.emit(concat([u32(this.reserved), ascii('free'), zeros(this.reserved - 8)]));
    this.emit(concat([u32(0), ascii('mdat')]));
  }

  private emit(bytes: Uint8Array): void {
    // Counted first: the writer may transfer the bytes away (leaving this view empty).
    const n = bytes.length;
    this.out.write(bytes);
    this.pos += n;
  }

  addVideo(chunk: MuxChunk): void {
    this.vq.push(chunk);
    this.drain(false);
  }

  addAudio(chunk: MuxChunk): void {
    this.aq.push(chunk);
    this.drain(false);
  }

  endVideo(): void {
    this.vEnded = true;
    this.drain(false);
  }

  endAudio(): void {
    this.aEnded = true;
    this.drain(false);
  }

  get pending(): number {
    return this.vq.length + this.aq.length;
  }

  private drain(final: boolean): void {
    const hasAudio = !!this.opts.audio;
    for (;;) {
      const v = this.vq[0];
      const a = this.aq[0];
      let from: 'v' | 'a';
      if (v && a) from = v.timestampUs <= a.timestampUs ? 'v' : 'a';
      else if (v && (final || this.aEnded || !hasAudio)) from = 'v';
      else if (a && (final || this.vEnded)) from = 'a';
      else return;
      if (from === 'v') this.takeVideo(this.vq.shift() as MuxChunk);
      else this.takeAudio(this.aq.shift() as MuxChunk);
    }
  }

  private startGroup(ms: number): Group {
    this.flushGroup();
    return (this.group = {
      startMs: ms,
      video: [],
      videoSamples: 0,
      videoBytes: 0,
      audio: [],
      audioSamples: 0,
      audioBytes: 0,
    });
  }

  private takeVideo(c: MuxChunk): void {
    const ms = c.timestampUs / 1000;
    const g = !this.group || ms - this.group.startMs >= this.groupMs ? this.startGroup(ms) : this.group;
    const ticks = Math.round((c.timestampUs * VIDEO_TIMESCALE) / 1_000_000);
    if (this.lastVideoTicks >= 0) {
      if (ticks <= this.lastVideoTicks)
        throw new Mp4Error('The video encoder reordered frames, which this MP4 writer cannot store. Use WebM instead.');
      pushDuration(this.vt, ticks - this.lastVideoTicks);
    }
    this.lastVideoTicks = ticks;
    this.lastVideoDuration = Math.max(1, Math.round((c.durationUs * VIDEO_TIMESCALE) / 1_000_000));
    this.vt.sizes.push(c.data.length);
    if (c.key) this.vt.syncs.push(this.vt.sizes.length);
    g.video.push(c.data);
    g.videoSamples++;
    g.videoBytes += c.data.length;
  }

  private takeAudio(c: MuxChunk): void {
    const ms = c.timestampUs / 1000;
    const g = !this.group || ms - this.group.startMs >= this.groupMs ? this.startGroup(ms) : this.group;
    // Every AAC-LC packet is 1024 samples long, whatever time the encoder stamped on it.
    pushDuration(this.at, AAC_FRAME);
    this.at.sizes.push(c.data.length);
    g.audio.push(c.data);
    g.audioSamples++;
    g.audioBytes += c.data.length;
  }

  private flushGroup(): void {
    const g = this.group;
    if (!g) return;
    this.group = null;
    if (this.dataBytes + g.videoBytes + g.audioBytes + this.dataAt > MAX_BYTES)
      throw new Mp4Error(
        'This video is too long for an MP4 file (4 GB). Export it as WebM, or a shorter part of the song.',
      );
    if (g.videoSamples > 0) {
      this.vt.chunkOffsets.push(this.dataBytes);
      this.vt.chunkSamples.push(g.videoSamples);
      for (const d of g.video) this.dataBytes += d.length;
      this.emit(concat(g.video));
    }
    if (g.audioSamples > 0) {
      this.at.chunkOffsets.push(this.dataBytes);
      this.at.chunkSamples.push(g.audioSamples);
      for (const d of g.audio) this.dataBytes += d.length;
      this.emit(concat(g.audio));
    }
  }

  /**
   * Ends the file: the last group, then the real index and the mdat size written over the start.
   * `audioFrames`: samples of audio the encoder was given; the encoder pads its last packet (and may add one to
   * flush its delay), and the edit list cuts the sound where the music ends.
   */
  finish(audioFrames?: number): void {
    if (this.finished) return;
    this.finished = true;
    this.vEnded = this.aEnded = true;
    this.drain(true);
    this.flushGroup();
    // The last video frame lasts as long as the encoder said (or as long as the one before it).
    if (this.lastVideoTicks >= 0) pushDuration(this.vt, this.lastVideoDuration);
    const o = this.opts;
    const moov = buildMoov({
      video: o.video,
      videoTable: this.vt,
      ...(o.audio ? { audio: o.audio, audioTable: this.at } : {}),
      base: this.dataAt,
      audioFrames,
    });
    const room = this.reserved - moov.length;
    if (room < 8)
      throw new Mp4Error(
        'The MP4 index outgrew the space reserved for it: the video is longer than planned. Use WebM, or export a shorter part.',
      );
    this.out.patch(this.moovAt, concat([moov, u32(room), ascii('free'), zeros(room - 8)]));
    this.out.patch(this.mdatAt, u32(8 + this.dataBytes));
    this.size = this.pos;
  }
}
