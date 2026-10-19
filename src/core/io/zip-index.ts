/**
 * Reads a zip a piece at a time (big project files: hundreds of MB of embedded songs): the central
 * directory from the end of the file, then each entry on its own, so only one entry is in memory at
 * a time. Pure: the caller gives a reader for byte ranges (File.slice in the app, an array in tests).
 * Stored and deflated entries; no zip64 (fflate writes none; files stay under 4 GB).
 */
import { inflateSync, strFromU8 } from 'fflate';

/** Reads `length` bytes at `offset` (fewer at the end of the file). */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/** One file in a zip's central directory: its name, how it is stored, its sizes, CRC-32 and where its data starts. */
export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  /** Offset of the entry's local header. */
  headerOffset: number;
}

/** Thrown when a file is not a zip this reader can open (no directory, or a damaged one). */
export class ZipFormatError extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The entries listed in the central directory. Throws ZipFormatError when there is none. */
export async function readZipIndex(read: RangeReader, fileSize: number): Promise<ZipEntry[]> {
  // The end record is 22 bytes plus a comment of up to 64 KB.
  const tailLen = Math.min(fileSize, 22 + 0xffff);
  const tail = await read(fileSize - tailLen, tailLen);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === EOCD && i + 22 + tv.getUint16(i + 20, true) <= tail.length) {
      e = i;
      break;
    }
  }
  if (e < 0) throw new ZipFormatError('No zip directory.');
  const count = tv.getUint16(e + 10, true);
  const dirSize = tv.getUint32(e + 12, true);
  const dirOffset = tv.getUint32(e + 16, true);
  if (dirOffset + dirSize > fileSize) throw new ZipFormatError('The zip directory is outside the file.');
  const dir = await read(dirOffset, dirSize);
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries: ZipEntry[] = [];
  let o = 0;
  for (let n = 0; n < count; n++) {
    if (o + 46 > dir.length || dv.getUint32(o, true) !== CENTRAL) throw new ZipFormatError('A damaged zip directory.');
    const nameLen = dv.getUint16(o + 28, true);
    const extraLen = dv.getUint16(o + 30, true);
    const commentLen = dv.getUint16(o + 32, true);
    entries.push({
      method: dv.getUint16(o + 10, true),
      crc: dv.getUint32(o + 16, true),
      compressedSize: dv.getUint32(o + 20, true),
      size: dv.getUint32(o + 24, true),
      headerOffset: dv.getUint32(o + 42, true),
      name: strFromU8(dir.subarray(o + 46, o + 46 + nameLen)),
    });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Where an entry's data starts (after its local header). */
export async function entryDataOffset(read: RangeReader, entry: ZipEntry): Promise<number> {
  const h = await read(entry.headerOffset, 30);
  const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
  if (h.length < 30 || v.getUint32(0, true) !== LOCAL) throw new ZipFormatError('A damaged zip entry.');
  return entry.headerOffset + 30 + v.getUint16(26, true) + v.getUint16(28, true);
}

/** An entry's contents (inflated when deflated). */
export async function readZipEntry(read: RangeReader, entry: ZipEntry): Promise<Uint8Array> {
  const start = await entryDataOffset(read, entry);
  const data = await read(start, entry.compressedSize);
  if (data.length < entry.compressedSize) throw new ZipFormatError('A zip entry is cut short.');
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateSync(data, { out: new Uint8Array(entry.size) });
  throw new ZipFormatError(`Unsupported zip compression (method ${entry.method}).`);
}

/** A reader over bytes in memory. */
export function bytesReader(bytes: Uint8Array): RangeReader {
  return async (offset, length) => bytes.subarray(Math.max(0, offset), Math.min(bytes.length, offset + length));
}
