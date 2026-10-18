/**
 * Splits the event stream of an .flp into events (RFC-less format: see `flp.ts` for the layout) and feeds
 * them to the reader.
 */
import type { FlpView } from './flp-bytes';
import type { FlpEventReader } from './flp-reader';

/** Event ids below 64 carry 1 byte, below 128 two bytes, below 192 four bytes; the rest are length-prefixed. */
const WORD_EVENT_MIN_ID = 64;
const DWORD_EVENT_MIN_ID = 128;
const DATA_EVENT_MIN_ID = 192;
/** A length prefix is LEB128: 7 bits per byte, at most 5 bytes (shift 28) for a 32-bit size. */
const MAX_LENGTH_PREFIX_SHIFT = 28;

/**
 * Splits the event stream `bytes[start…end)` into events and feeds them to `reader`. Stops with a warning
 * (keeping what was read) at a damaged length or an event that runs past the end.
 */
export function scanEvents(bytes: Uint8Array, view: FlpView, start: number, end: number, reader: FlpEventReader): void {
  const warnings = reader.project.warnings;
  let position = start;
  while (position < end) {
    const id = bytes[position++] as number;
    let size: number;
    if (id < WORD_EVENT_MIN_ID) size = 1;
    else if (id < DWORD_EVENT_MIN_ID) size = 2;
    else if (id < DATA_EVENT_MIN_ID) size = 4;
    else {
      // A length prefix: LEB128, 7 bits per byte, low group first. (Inline: this runs once per event.)
      size = 0;
      let shift = 0;
      let isComplete = false;
      while (position < end && shift <= MAX_LENGTH_PREFIX_SHIFT) {
        const byte = bytes[position++] as number;
        size += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if (!(byte & 0x80)) {
          isComplete = true;
          break;
        }
      }
      if (!isComplete) {
        warnings.push('The file is damaged near the end; what could be read was imported.');
        break;
      }
    }
    if (position + size > end) {
      // The header may have said so already (its length reaches past the end of the file).
      const cutOff = 'The file is cut off; what could be read was imported.';
      if (!warnings.includes(cutOff)) warnings.push(cutOff);
      break;
    }
    const at = position;
    position += size;
    reader.handleEvent(id, size, at, eventValue(view, id, size, at));
  }
}

/** The payload of a 1, 2 or 4 byte event as a number (0 for data events and sizes that don't match the id). */
function eventValue(view: FlpView, id: number, size: number, at: number): number {
  if (size === 1) return view.u8(at);
  if (size === 2 && id < DWORD_EVENT_MIN_ID) return view.u16(at);
  if (size === 4 && id < DATA_EVENT_MIN_ID) return view.u32(at);
  return 0;
}
