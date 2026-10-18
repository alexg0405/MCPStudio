/**
 * A WebM reader for the tests: walks the EBML structure of a file and returns what is in it, written
 * separately from the muxer so the tests check the bytes against the format, not against the writer.
 */

export interface ParsedBlock {
  track: number;
  /** Absolute time in milliseconds (cluster time + the block's offset). */
  ms: number;
  key: boolean;
  size: number;
  /** Bytes of the block's data. */
  data: Uint8Array;
}

export interface ParsedTrack {
  number: number;
  uid: number;
  type: number;
  codecId: string;
  codecPrivate?: Uint8Array;
  codecDelay?: number;
  seekPreRoll?: number;
  defaultDuration?: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
}

export interface ParsedCue {
  timeMs: number;
  track: number;
  clusterPosition: number;
}

export interface ParsedWebm {
  docType: string;
  /** The Segment's size field: a number, or null when it says "unknown". */
  segmentSize: number | null;
  /** Absolute file offset where the Segment's data begins. */
  segmentStart: number;
  seeks: Array<{ id: number; position: number }>;
  info: { timecodeScale: number; duration: number; title?: string; muxingApp?: string };
  tracks: ParsedTrack[];
  clusters: Array<{ offset: number; timecodeMs: number; size: number; blocks: ParsedBlock[] }>;
  cues: ParsedCue[];
  /** Absolute offsets (from the Segment's data start) of the top-level elements, in order: [id, offset]. */
  top: Array<[number, number]>;
  /** Offsets from the Segment's data start of each parsed top-level element's end. */
  end: number;
}

const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  Title: 0x7ba9,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
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
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
};

interface El {
  id: number;
  /** Offset of the element's first byte. */
  at: number;
  /** Offset of its payload. */
  start: number;
  /** Payload size, or -1 for unknown. */
  size: number;
  /** Bytes the size field used. */
  sizeWidth: number;
}

function readEl(b: Uint8Array, at: number): El {
  const first = b[at] as number;
  let idLen = 1;
  while (idLen <= 4 && !(first & (0x80 >> (idLen - 1)))) idLen++;
  if (idLen > 4) throw new Error(`bad element id at ${at}`);
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + (b[at + i] as number);
  const sAt = at + idLen;
  const s0 = b[sAt] as number;
  let w = 1;
  while (w <= 8 && !(s0 & (0x80 >> (w - 1)))) w++;
  if (w > 8) throw new Error(`bad size at ${sAt}`);
  let size = s0 & (0xff >> w);
  let allOnes = size === 0xff >> w;
  for (let i = 1; i < w; i++) {
    const v = b[sAt + i] as number;
    size = size * 256 + v;
    if (v !== 0xff) allOnes = false;
  }
  return { id, at, start: sAt + w, size: allOnes ? -1 : size, sizeWidth: w };
}

const uintOf = (b: Uint8Array, el: El): number => {
  let v = 0;
  for (let i = 0; i < el.size; i++) v = v * 256 + (b[el.start + i] as number);
  return v;
};

const floatOf = (b: Uint8Array, el: El): number => {
  const dv = new DataView(b.buffer, b.byteOffset + el.start, el.size);
  return el.size === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
};

const textOf = (b: Uint8Array, el: El): string => new TextDecoder().decode(b.subarray(el.start, el.start + el.size));

function children(b: Uint8Array, from: number, to: number): El[] {
  const out: El[] = [];
  let at = from;
  while (at < to) {
    const el = readEl(b, at);
    out.push(el);
    if (el.size < 0) break;
    at = el.start + el.size;
  }
  return out;
}

export function parseWebm(b: Uint8Array): ParsedWebm {
  const top = children(b, 0, b.length);
  const ebml = top.find((e) => e.id === ID.EBML);
  if (!ebml) throw new Error('no EBML header');
  const docType = textOf(b, children(b, ebml.start, ebml.start + ebml.size).find((e) => e.id === ID.DocType) as El);
  const segment = top.find((e) => e.id === ID.Segment);
  if (!segment) throw new Error('no Segment');
  const segEnd = segment.size < 0 ? b.length : segment.start + segment.size;
  const out: ParsedWebm = {
    docType,
    segmentSize: segment.size < 0 ? null : segment.size,
    segmentStart: segment.start,
    seeks: [],
    info: { timecodeScale: 1_000_000, duration: 0 },
    tracks: [],
    clusters: [],
    cues: [],
    top: [],
    end: segEnd - segment.start,
  };
  let at = segment.start;
  while (at < segEnd) {
    const el = readEl(b, at);
    out.top.push([el.id, el.at - segment.start]);
    const end = el.start + el.size;
    const kids = () => children(b, el.start, end);
    if (el.id === ID.SeekHead) {
      for (const seek of kids()) {
        const sk = children(b, seek.start, seek.start + seek.size);
        const idEl = sk.find((e) => e.id === ID.SeekID) as El;
        let id = 0;
        for (let i = 0; i < idEl.size; i++) id = id * 256 + (b[idEl.start + i] as number);
        out.seeks.push({ id, position: uintOf(b, sk.find((e) => e.id === ID.SeekPosition) as El) });
      }
    } else if (el.id === ID.Info) {
      for (const k of kids()) {
        if (k.id === ID.TimecodeScale) out.info.timecodeScale = uintOf(b, k);
        else if (k.id === ID.Duration) out.info.duration = floatOf(b, k);
        else if (k.id === ID.Title) out.info.title = textOf(b, k);
        else if (k.id === ID.MuxingApp) out.info.muxingApp = textOf(b, k);
      }
    } else if (el.id === ID.Tracks) {
      for (const te of kids()) {
        const t: ParsedTrack = { number: 0, uid: 0, type: 0, codecId: '' };
        for (const k of children(b, te.start, te.start + te.size)) {
          if (k.id === ID.TrackNumber) t.number = uintOf(b, k);
          else if (k.id === ID.TrackUID) t.uid = uintOf(b, k);
          else if (k.id === ID.TrackType) t.type = uintOf(b, k);
          else if (k.id === ID.CodecID) t.codecId = textOf(b, k);
          else if (k.id === ID.CodecPrivate) t.codecPrivate = b.slice(k.start, k.start + k.size);
          else if (k.id === ID.CodecDelay) t.codecDelay = uintOf(b, k);
          else if (k.id === ID.SeekPreRoll) t.seekPreRoll = uintOf(b, k);
          else if (k.id === ID.DefaultDuration) t.defaultDuration = uintOf(b, k);
          else if (k.id === ID.Video) {
            for (const v of children(b, k.start, k.start + k.size)) {
              if (v.id === ID.PixelWidth) t.width = uintOf(b, v);
              if (v.id === ID.PixelHeight) t.height = uintOf(b, v);
            }
          } else if (k.id === ID.Audio) {
            for (const v of children(b, k.start, k.start + k.size)) {
              if (v.id === ID.SamplingFrequency) t.sampleRate = floatOf(b, v);
              if (v.id === ID.Channels) t.channels = uintOf(b, v);
            }
          }
        }
        out.tracks.push(t);
      }
    } else if (el.id === ID.Cluster) {
      let timecodeMs = 0;
      const blocks: ParsedBlock[] = [];
      const kidsOf = kids();
      const tc = kidsOf.find((e) => e.id === ID.Timecode);
      if (tc) timecodeMs = uintOf(b, tc);
      for (const k of kidsOf) {
        if (k.id !== ID.SimpleBlock) continue;
        const track = (b[k.start] as number) & 0x7f;
        const rel = ((((b[k.start + 1] as number) << 8) | (b[k.start + 2] as number)) << 16) >> 16;
        const flags = b[k.start + 3] as number;
        blocks.push({
          track,
          ms: timecodeMs + rel,
          key: !!(flags & 0x80),
          size: k.size - 4,
          data: b.subarray(k.start + 4, k.start + k.size),
        });
      }
      out.clusters.push({ offset: el.at - segment.start, timecodeMs, size: el.size, blocks });
    } else if (el.id === ID.Cues) {
      for (const cp of kids()) {
        let timeMs = 0;
        let track = 0;
        let clusterPosition = 0;
        for (const k of children(b, cp.start, cp.start + cp.size)) {
          if (k.id === ID.CueTime) timeMs = uintOf(b, k);
          else if (k.id === ID.CueTrackPositions) {
            for (const v of children(b, k.start, k.start + k.size)) {
              if (v.id === ID.CueTrack) track = uintOf(b, v);
              if (v.id === ID.CueClusterPosition) clusterPosition = uintOf(b, v);
            }
          }
        }
        out.cues.push({ timeMs, track, clusterPosition });
      }
    }
    if (el.size < 0) break;
    at = end;
  }
  return out;
}
