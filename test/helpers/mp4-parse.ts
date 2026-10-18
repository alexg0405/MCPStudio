/**
 * An MP4 reader for the tests: the box tree, the movie header and each track's sample tables, and a
 * function that reads every sample's bytes back through them. Written separately from the muxer.
 */

export interface Box {
  type: string;
  /** Offset of the box's first byte. */
  at: number;
  size: number;
  /** Offset of its payload (after the 8-byte header). */
  start: number;
}

export function boxes(b: Uint8Array, from = 0, to = b.length): Box[] {
  const out: Box[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = from;
  while (at + 8 <= to) {
    let size = dv.getUint32(at);
    const type = String.fromCharCode(b[at + 4] as number, b[at + 5] as number, b[at + 6] as number, b[at + 7] as number);
    let start = at + 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(at + 8));
      start = at + 16;
    } else if (size === 0) size = to - at;
    if (size < 8 || at + size > to) throw new Error(`bad box ${type} at ${at} (size ${size}, parent ends ${to})`);
    out.push({ type, at, size, start });
    at += size;
  }
  if (at !== to) throw new Error(`boxes do not fill their parent: stopped at ${at} of ${to}`);
  return out;
}

const find = (list: Box[], type: string): Box | undefined => list.find((x) => x.type === type);

export interface ParsedTrack {
  id: number;
  handler: string;
  timescale: number;
  mediaDuration: number;
  /** tkhd duration, movie timescale. */
  duration: number;
  width: number;
  height: number;
  entry: string;
  /** Contents of the codec box inside the sample entry: avcC, or the esds payload. */
  codecBox: Uint8Array;
  stts: Array<[number, number]>;
  stss: number[] | null;
  stsc: Array<[number, number, number]>;
  sizes: number[];
  chunkOffsets: number[];
  elst: Array<{ duration: number; mediaTime: number }>;
}

export interface ParsedMp4 {
  top: Box[];
  brands: string[];
  movie: { timescale: number; duration: number; nextTrack: number };
  tracks: ParsedTrack[];
  mdat: Box;
  moov: Box;
}

export function parseMp4(b: Uint8Array): ParsedMp4 {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const top = boxes(b);
  const ftyp = find(top, 'ftyp');
  const moov = find(top, 'moov');
  const mdat = find(top, 'mdat');
  if (!ftyp || !moov || !mdat) throw new Error('missing ftyp, moov or mdat');
  const brands = [String.fromCharCode(...b.subarray(ftyp.start, ftyp.start + 4))];
  for (let o = ftyp.start + 8; o + 4 <= ftyp.at + ftyp.size; o += 4) brands.push(String.fromCharCode(...b.subarray(o, o + 4)));
  const kids = boxes(b, moov.start, moov.at + moov.size);
  const mvhd = find(kids, 'mvhd');
  if (!mvhd) throw new Error('no mvhd');
  const movie = {
    timescale: dv.getUint32(mvhd.start + 12),
    duration: dv.getUint32(mvhd.start + 16),
    nextTrack: dv.getUint32(mvhd.start + 96),
  };
  const tracks: ParsedTrack[] = [];
  for (const trak of kids.filter((k) => k.type === 'trak')) {
    const tk = boxes(b, trak.start, trak.at + trak.size);
    const tkhd = find(tk, 'tkhd') as Box;
    const id = dv.getUint32(tkhd.start + 12);
    const duration = dv.getUint32(tkhd.start + 20);
    const width = dv.getUint32(tkhd.start + 76) / 65536;
    const height = dv.getUint32(tkhd.start + 80) / 65536;
    const elstBox = find(tk, 'edts') ? find(boxes(b, (find(tk, 'edts') as Box).start, (find(tk, 'edts') as Box).at + (find(tk, 'edts') as Box).size), 'elst') : undefined;
    const elst: ParsedTrack['elst'] = [];
    if (elstBox) {
      const n = dv.getUint32(elstBox.start + 4);
      for (let i = 0; i < n; i++)
        elst.push({ duration: dv.getUint32(elstBox.start + 8 + 12 * i), mediaTime: dv.getInt32(elstBox.start + 12 + 12 * i) });
    }
    const mdia = find(tk, 'mdia') as Box;
    const md = boxes(b, mdia.start, mdia.at + mdia.size);
    const mdhd = find(md, 'mdhd') as Box;
    const hdlr = find(md, 'hdlr') as Box;
    const minf = find(md, 'minf') as Box;
    const mf = boxes(b, minf.start, minf.at + minf.size);
    const stbl = find(mf, 'stbl') as Box;
    const st = boxes(b, stbl.start, stbl.at + stbl.size);
    const stsd = find(st, 'stsd') as Box;
    const entry = boxes(b, stsd.start + 8, stsd.at + stsd.size)[0] as Box;
    // The codec box sits after the fixed part of the sample entry: 78 bytes (video) or 28 (audio).
    const isVideo = String.fromCharCode(...b.subarray(hdlr.start + 8, hdlr.start + 12)) === 'vide';
    const inner = boxes(b, entry.start + (isVideo ? 78 : 28), entry.at + entry.size);
    const codec = inner[0] as Box;
    const tbl = (type: string) => find(st, type);
    const stts = tbl('stts') as Box;
    const sttsN = dv.getUint32(stts.start + 4);
    const sttsRows: Array<[number, number]> = [];
    for (let i = 0; i < sttsN; i++) sttsRows.push([dv.getUint32(stts.start + 8 + 8 * i), dv.getUint32(stts.start + 12 + 8 * i)]);
    const stssBox = tbl('stss');
    const stss: number[] | null = stssBox ? [] : null;
    if (stssBox && stss) {
      const n = dv.getUint32(stssBox.start + 4);
      for (let i = 0; i < n; i++) stss.push(dv.getUint32(stssBox.start + 8 + 4 * i));
    }
    const stscBox = tbl('stsc') as Box;
    const stscN = dv.getUint32(stscBox.start + 4);
    const stsc: Array<[number, number, number]> = [];
    for (let i = 0; i < stscN; i++)
      stsc.push([dv.getUint32(stscBox.start + 8 + 12 * i), dv.getUint32(stscBox.start + 12 + 12 * i), dv.getUint32(stscBox.start + 16 + 12 * i)]);
    const stszBox = tbl('stsz') as Box;
    const fixed = dv.getUint32(stszBox.start + 4);
    const stszN = dv.getUint32(stszBox.start + 8);
    const sizes: number[] = [];
    for (let i = 0; i < stszN; i++) sizes.push(fixed || dv.getUint32(stszBox.start + 12 + 4 * i));
    const stcoBox = tbl('stco') as Box;
    const stcoN = dv.getUint32(stcoBox.start + 4);
    const chunkOffsets: number[] = [];
    for (let i = 0; i < stcoN; i++) chunkOffsets.push(dv.getUint32(stcoBox.start + 8 + 4 * i));
    tracks.push({
      id,
      handler: String.fromCharCode(...b.subarray(hdlr.start + 8, hdlr.start + 12)),
      timescale: dv.getUint32(mdhd.start + 12),
      mediaDuration: dv.getUint32(mdhd.start + 16),
      duration,
      width,
      height,
      entry: entry.type,
      codecBox: b.slice(codec.start, codec.at + codec.size),
      stts: sttsRows,
      stss,
      stsc,
      sizes,
      chunkOffsets,
      elst,
    });
  }
  return { top, brands, movie, tracks, mdat, moov };
}

/** Which chunk each sample is in and where it sits in the file, from the track's tables. */
export function sampleLocations(t: ParsedTrack): Array<{ offset: number; size: number }> {
  const out: Array<{ offset: number; size: number }> = [];
  let sample = 0;
  for (let c = 0; c < t.chunkOffsets.length; c++) {
    // The stsc entry in force for chunk c+1.
    let perChunk = 0;
    for (const [first, n] of t.stsc) if (first <= c + 1) perChunk = n;
    let offset = t.chunkOffsets[c] as number;
    for (let i = 0; i < perChunk; i++) {
      const size = t.sizes[sample++] as number;
      out.push({ offset, size });
      offset += size;
    }
  }
  return out;
}

export function readSamples(file: Uint8Array, t: ParsedTrack): Uint8Array[] {
  return sampleLocations(t).map((s) => file.subarray(s.offset, s.offset + s.size));
}
