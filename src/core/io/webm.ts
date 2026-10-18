/**
 * A small WebM (Matroska/EBML) muxer for one video and one audio track, written for streaming: the
 * file is produced a cluster at a time (about two seconds each, starting at a key frame) and only
 * three things are written over afterwards (the segment's size, the duration and the position of
 * the cues), so a long video never sits in memory. Video and audio chunks arrive in separate
 * queues and are interleaved by time. At the end it writes the Cues (one per cluster, on the video
 * track) so players can seek, and a crashed export still plays as far as it got (the segment size
 * starts out as "unknown").
 *
 * Pure bytes in, bytes out through a `MuxWriter`: no DOM, no Worker; the tests parse the output back.
 */

/** Where the muxer's bytes go. `patch` writes over bytes already written (never past the end). */
export interface MuxWriter {
  write(bytes: Uint8Array): void;
  patch(at: number, bytes: Uint8Array): void;
}

/** One encoded video frame or audio packet. */
export interface MuxChunk {
  /** Presentation time in microseconds. */
  timestampUs: number;
  durationUs: number;
  key: boolean;
  data: Uint8Array;
}

export interface WebmVideoTrack {
  codec: 'V_VP9' | 'V_AV1' | 'V_VP8';
  width: number;
  height: number;
  fps: number;
  /** AV1: the av1C record; VP9 needs none. */
  codecPrivate?: Uint8Array | undefined;
}

export interface WebmAudioTrack {
  codec: 'A_OPUS';
  channels: number;
  sampleRate: number;
  /** The OpusHead packet (the encoder's description). */
  codecPrivate: Uint8Array;
  /** Samples at 48 kHz the decoder drops from the start (the Opus pre-skip). */
  preSkip: number;
}

export interface WebmOptions {
  video: WebmVideoTrack;
  audio?: WebmAudioTrack | undefined;
  /** A cluster is closed at the first key frame after this many milliseconds (default 1900). */
  clusterMs?: number;
  title?: string | undefined;
}

// ---------------------------------------------------------------- EBML encoding

/** Element ids (the id's own bytes, marker bits included). */
const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Title: 0x7ba9,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  BitDepth: 0x6264,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

export const WEBM_IDS = ID;

/** UTF-8 bytes of a string (core has no TextEncoder: it is DOM-free). */
function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

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

/** The id as bytes (1–4). */
function idBytes(id: number): Uint8Array {
  const n = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (id >>> (8 * (n - 1 - i))) & 0xff;
  return out;
}

/** A size as an EBML variable-length integer, as short as it can be (or `width` bytes). */
export function sizeBytes(size: number, width = 0): Uint8Array {
  let n = width;
  if (n === 0) {
    n = 1;
    // All-ones is reserved for "unknown size", so a size fits in n bytes when it is below 2^(7n) − 1.
    while (n < 8 && size >= 2 ** (7 * n) - 1) n++;
  }
  const out = new Uint8Array(n);
  let v = size;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] = (out[0] as number) | (0x80 >> (n - 1));
  return out;
}

function element(id: number, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), sizeBytes(payload.length), payload]);
}

function elementOf(id: number, ...children: Uint8Array[]): Uint8Array {
  return element(id, concat(children));
}

/** An unsigned integer in as few bytes as it fits (or `width`). */
function uintBytes(v: number, width = 0): Uint8Array {
  let n = width || 1;
  if (!width) while (n < 8 && v >= 2 ** (8 * n)) n++;
  const out = new Uint8Array(n);
  let x = v;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = x % 256;
    x = Math.floor(x / 256);
  }
  return out;
}

const uint = (id: number, v: number, width = 0) => element(id, uintBytes(v, width));
const str = (id: number, s: string) => element(id, utf8(s));

function float64(v: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, v);
  return out;
}

function float32(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, v);
  return out;
}

// ---------------------------------------------------------------- the muxer

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;

interface Cluster {
  startMs: number;
  /** Offset of the cluster's first byte from the start of the segment's data. */
  position: number;
  blocks: Uint8Array[];
  bytes: number;
}

interface Cue {
  timeMs: number;
  position: number;
}

export class WebmMuxer {
  private pos = 0;
  private segmentStart = 0;
  private cluster: Cluster | null = null;
  private readonly cues: Cue[] = [];
  private readonly vq: MuxChunk[] = [];
  private readonly aq: MuxChunk[] = [];
  private vEnded = false;
  private aEnded = false;
  private finished = false;
  private lastEndUs = 0;
  /** Where the Duration's 8 bytes and the Cues' SeekPosition sit in the file, and where the Segment's size is. */
  private durationAt = 0;
  private cuesSeekAt = 0;
  private segmentSizeAt = 0;
  private readonly clusterMs: number;
  /** Bytes of the finished file (known after finish()). */
  size = 0;
  /** Chunks written to the file so far. */
  blocksWritten = 0;

  constructor(
    private readonly out: MuxWriter,
    private readonly opts: WebmOptions,
  ) {
    this.clusterMs = opts.clusterMs ?? 1900;
    this.writeHeader();
  }

  private emit(bytes: Uint8Array): void {
    // Counted first: the writer may transfer the bytes away (leaving this view empty).
    const n = bytes.length;
    this.out.write(bytes);
    this.pos += n;
  }

  private writeHeader(): void {
    const { video, audio } = this.opts;
    this.emit(
      elementOf(
        ID.EBML,
        uint(ID.EBMLVersion, 1),
        uint(ID.EBMLReadVersion, 1),
        uint(ID.EBMLMaxIDLength, 4),
        uint(ID.EBMLMaxSizeLength, 8),
        str(ID.DocType, 'webm'),
        uint(ID.DocTypeVersion, 4),
        uint(ID.DocTypeReadVersion, 2),
      ),
    );
    // The Segment: its size is "unknown" (all ones) until finish() writes the real one over it.
    this.emit(idBytes(ID.Segment));
    this.segmentSizeAt = this.pos;
    this.emit(new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    this.segmentStart = this.pos;

    const title = this.opts.title;
    const info = elementOf(
      ID.Info,
      uint(ID.TimecodeScale, 1_000_000),
      str(ID.MuxingApp, 'AGstudio'),
      str(ID.WritingApp, 'AGstudio'),
      ...(title ? [str(ID.Title, title)] : []),
      element(ID.Duration, float64(0)),
    );
    const videoEntry = elementOf(
      ID.TrackEntry,
      uint(ID.TrackNumber, VIDEO_TRACK),
      uint(ID.TrackUID, VIDEO_TRACK),
      uint(ID.TrackType, 1),
      uint(ID.FlagLacing, 0),
      str(ID.CodecID, video.codec),
      uint(ID.DefaultDuration, Math.round(1e9 / video.fps)),
      ...(video.codecPrivate && video.codecPrivate.length ? [element(ID.CodecPrivate, video.codecPrivate)] : []),
      elementOf(ID.Video, uint(ID.PixelWidth, video.width), uint(ID.PixelHeight, video.height)),
    );
    const audioEntry = audio
      ? elementOf(
          ID.TrackEntry,
          uint(ID.TrackNumber, AUDIO_TRACK),
          uint(ID.TrackUID, AUDIO_TRACK),
          uint(ID.TrackType, 2),
          uint(ID.FlagLacing, 0),
          str(ID.CodecID, audio.codec),
          element(ID.CodecPrivate, audio.codecPrivate),
          // The decoder drops the pre-skip; nanoseconds at 48 kHz.
          uint(ID.CodecDelay, Math.round((audio.preSkip * 1e9) / 48000)),
          uint(ID.SeekPreRoll, 80_000_000),
          elementOf(
            ID.Audio,
            element(ID.SamplingFrequency, float32(audio.sampleRate)),
            uint(ID.Channels, audio.channels),
          ),
        )
      : new Uint8Array(0);
    const tracks = elementOf(ID.Tracks, videoEntry, audioEntry);

    // The SeekHead goes first and has a fixed size (8-byte positions), so the positions it holds are known now.
    const seek = (id: number, position: number) =>
      elementOf(ID.Seek, element(ID.SeekID, idBytes(id)), uint(ID.SeekPosition, position, 8));
    const probe = elementOf(ID.SeekHead, seek(ID.Info, 0), seek(ID.Tracks, 0), seek(ID.Cues, 0));
    const infoAt = probe.length;
    const tracksAt = infoAt + info.length;
    const head = elementOf(ID.SeekHead, seek(ID.Info, infoAt), seek(ID.Tracks, tracksAt), seek(ID.Cues, 0));
    // The Cues' SeekPosition value is the last 8 bytes of the last entry.
    this.cuesSeekAt = this.pos + head.length - 8;
    // Duration is the last element of Info: its 8-byte payload ends the element.
    this.durationAt = this.pos + head.length + info.length - 8;
    this.emit(head);
    this.emit(info);
    this.emit(tracks);
  }

  addVideo(chunk: MuxChunk): void {
    this.vq.push(chunk);
    this.drain(false);
  }

  addAudio(chunk: MuxChunk): void {
    this.aq.push(chunk);
    this.drain(false);
  }

  /** No more video (and `endAudio` for the sound): lets the other queue drain without waiting. */
  endVideo(): void {
    this.vEnded = true;
    this.drain(false);
  }

  endAudio(): void {
    this.aEnded = true;
    this.drain(false);
  }

  /** Chunks waiting to be written (the muxer holds one queue back while it waits for the other). */
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
      // One queue is empty: wait for it unless it has ended (or never will come).
      else if (v && (final || this.aEnded || !hasAudio)) from = 'v';
      else if (a && (final || this.vEnded)) from = 'a';
      else return;
      this.write(from === 'v' ? (this.vq.shift() as MuxChunk) : (this.aq.shift() as MuxChunk), from === 'v');
    }
  }

  private write(chunk: MuxChunk, video: boolean): void {
    const ms = Math.round(chunk.timestampUs / 1000);
    const c = this.cluster;
    if (!c || (video && chunk.key && ms - c.startMs >= this.clusterMs) || ms - c.startMs > 30_000) this.startCluster(ms);
    const cl = this.cluster as Cluster;
    const rel = ms - cl.startMs;
    // SimpleBlock: track number (1 byte), signed 16-bit time since the cluster, flags (0x80 = key frame).
    const head = new Uint8Array(4);
    head[0] = 0x80 | (video ? VIDEO_TRACK : AUDIO_TRACK);
    head[1] = (rel >> 8) & 0xff;
    head[2] = rel & 0xff;
    head[3] = chunk.key || !video ? 0x80 : 0;
    const block = element(ID.SimpleBlock, concat([head, chunk.data]));
    cl.blocks.push(block);
    cl.bytes += block.length;
    this.blocksWritten++;
    this.lastEndUs = Math.max(this.lastEndUs, chunk.timestampUs + chunk.durationUs);
  }

  private startCluster(startMs: number): void {
    this.flushCluster();
    this.cluster = { startMs, position: this.pos - this.segmentStart, blocks: [], bytes: 0 };
  }

  private flushCluster(): void {
    const c = this.cluster;
    if (!c) return;
    const body = concat([uint(ID.Timecode, c.startMs), ...c.blocks]);
    this.emit(concat([idBytes(ID.Cluster), sizeBytes(body.length), body]));
    this.cues.push({ timeMs: c.startMs, position: c.position });
    this.cluster = null;
  }

  /** Ends the file: the last cluster, the Cues, and the three numbers written over the header. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.vEnded = this.aEnded = true;
    this.drain(true);
    this.flushCluster();
    const cuesPosition = this.pos - this.segmentStart;
    if (this.cues.length > 0) {
      this.emit(
        elementOf(
          ID.Cues,
          ...this.cues.map((c) =>
            elementOf(
              ID.CuePoint,
              uint(ID.CueTime, c.timeMs),
              elementOf(ID.CueTrackPositions, uint(ID.CueTrack, VIDEO_TRACK), uint(ID.CueClusterPosition, c.position)),
            ),
          ),
        ),
      );
    }
    this.out.patch(this.cuesSeekAt, uintBytes(cuesPosition, 8));
    this.out.patch(this.durationAt, float64(this.lastEndUs / 1000));
    this.out.patch(this.segmentSizeAt, sizeBytes(this.pos - this.segmentStart, 8));
    this.size = this.pos;
  }
}
