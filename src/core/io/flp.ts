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
 *
 * This file reads the two chunk headers and is the public door; the pieces are `flp-format.ts` (ids,
 * layouts, result types), `flp-reader.ts` (events → project), `flp-records.ts` and `flp-bytes.ts`.
 */
import { FlpView } from './flp-bytes';
import { FLP_LIMITS, FlpError, type FlpProject } from './flp-format';
import { FlpEventReader } from './flp-reader';
import { scanEvents } from './flp-scan';

export * from './flp-format';
export { flpVersionAtLeast } from './flp-bytes';
export { playlistStride } from './flp-records';

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

/** Header layout: "FLhd", u32 length, then i16 format, u16 channel count, u16 PPQ. */
const FILE_HEADER_TAG = 'FLhd';
const DATA_CHUNK_TAG = 'FLdt';
const HEADER_LENGTH_OFFSET = 4;
const HEADER_FORMAT_OFFSET = 8;
const HEADER_CHANNEL_COUNT_OFFSET = 10;
const HEADER_PPQ_OFFSET = 12;
/** The smallest file that holds a complete header chunk. */
const MIN_FILE_BYTES = 14;
const MIN_HEADER_LENGTH = 6;
const MAX_HEADER_LENGTH = 4096;
/** Chunk header: a 4-byte tag and a u32 length. */
const CHUNK_HEADER_BYTES = 8;
/** How far past the header chunk to look for "FLdt" when stray bytes sit between the chunks. */
const DATA_CHUNK_SEARCH_BYTES = 256;
const DEFAULT_PPQ = 96;

/** Where the events are and what the header chunk says. */
interface FlpHeader {
  format: number;
  channelCount: number;
  ppq: number;
  /** Byte range of the event stream. */
  dataStart: number;
  dataEnd: number;
}

/** Reads an .flp. Throws FlpError when the bytes aren't a readable FL Studio project. */
export function parseFlp(bytes: Uint8Array): FlpProject {
  const view = new FlpView(bytes);
  const warnings: string[] = [];
  const header = readHeader(view, warnings);
  const reader = new FlpEventReader(view, header, warnings);
  scanEvents(bytes, view, header.dataStart, header.dataEnd, reader);
  return reader.finish();
}

/** Checks the file is a project and finds its event stream, adding a warning for each thing it forgives. */
function readHeader(view: FlpView, warnings: string[]): FlpHeader {
  const bytes = view.bytes;
  if (bytes.length > FLP_LIMITS.maxBytes) {
    throw new FlpError(`This FL Studio project is too large to import (over ${FLP_LIMITS.maxBytes >> 20} MB).`);
  }
  if (view.tag(0) !== FILE_HEADER_TAG) throw new FlpError("This isn't an FL Studio project (.flp) file.");
  if (bytes.length < MIN_FILE_BYTES) {
    throw new FlpError('The FL Studio project file is cut off (its header is incomplete).');
  }
  const headerLength = view.u32(HEADER_LENGTH_OFFSET);
  if (headerLength < MIN_HEADER_LENGTH || headerLength > MAX_HEADER_LENGTH || 8 + headerLength > bytes.length) {
    throw new FlpError('The FL Studio project file is damaged (its header is invalid).');
  }
  const format = view.i16(HEADER_FORMAT_OFFSET);
  const otherKind = OTHER_FORMATS[format];
  if (otherKind) throw new FlpError(`This is an FL Studio ${otherKind} file, not a project.`);
  const channelCount = view.u16(HEADER_CHANNEL_COUNT_OFFSET);
  let ppq = view.u16(HEADER_PPQ_OFFSET);
  if (ppq < 1) {
    warnings.push(`The file had no timing resolution; assumed ${DEFAULT_PPQ} PPQ.`);
    ppq = DEFAULT_PPQ;
  }

  const dataChunkAt = findDataChunk(view, CHUNK_HEADER_BYTES + headerLength);
  if (dataChunkAt + CHUNK_HEADER_BYTES > bytes.length) {
    throw new FlpError('The FL Studio project file is cut off before its data.');
  }
  const declaredLength = view.u32(dataChunkAt + 4);
  const dataStart = dataChunkAt + CHUNK_HEADER_BYTES;
  let dataEnd = dataStart + declaredLength;
  if (dataEnd > bytes.length) {
    warnings.push('The file is cut off; what could be read was imported.');
    dataEnd = bytes.length;
  }
  return { format, channelCount, ppq, dataStart, dataEnd };
}

/** The offset of the "FLdt" chunk: right after the header, or (tolerating stray bytes) a little later. */
function findDataChunk(view: FlpView, expectedAt: number): number {
  if (view.tag(expectedAt) === DATA_CHUNK_TAG) return expectedAt;
  const searchEnd = Math.min(view.bytes.length, expectedAt + DATA_CHUNK_SEARCH_BYTES);
  for (let at = expectedAt; at + 4 <= searchEnd; at++) {
    if (view.tag(at) === DATA_CHUNK_TAG) return at;
  }
  throw new FlpError('The FL Studio project file has no project data.');
}

/** Every distinct sample path the project's channels use. */
export function flpSamplePaths(flp: FlpProject): string[] {
  const paths = new Set<string>();
  for (const channel of flp.channels) {
    if (channel.samplePath) paths.add(channel.samplePath);
  }
  return [...paths];
}

/** The file name at the end of an FL path (Windows or Mac separators). */
export function flpFileName(path: string): string {
  return path.split(/[\\/]/).pop()?.trim() ?? path;
}
