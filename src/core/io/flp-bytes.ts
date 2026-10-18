/** Byte-level helpers of the .flp reader: little-endian reads, the text encodings, colours and version tests. */

/** Little-endian reads from a byte array, by byte offset. */
export class FlpView {
  private readonly dataView: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(offset: number): number {
    return this.bytes[offset] as number;
  }
  u16(offset: number): number {
    return this.dataView.getUint16(offset, true);
  }
  i16(offset: number): number {
    return this.dataView.getInt16(offset, true);
  }
  u32(offset: number): number {
    return this.dataView.getUint32(offset, true);
  }
  i32(offset: number): number {
    return this.dataView.getInt32(offset, true);
  }
  f32(offset: number): number {
    return this.dataView.getFloat32(offset, true);
  }
  f64(offset: number): number {
    return this.dataView.getFloat64(offset, true);
  }
  /** Four bytes as text (a chunk tag such as "FLhd"), or '' when the file ends before them. */
  tag(offset: number): string {
    return offset + 4 <= this.bytes.length ? latin1(this.bytes, offset, 4) : '';
  }
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** FL colours are COLORREF-style: bytes R, G, B, (alpha/unused). Returns "#rrggbb". */
export function colorOf(value: number): string {
  return `#${hex2(value & 0xff)}${hex2((value >>> 8) & 0xff)}${hex2((value >>> 16) & 0xff)}`;
}

/** Text with one byte per character (FL before 11.5, and the version text always). */
export function latin1(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[offset + i] as number);
  return text;
}

/** Text with two bytes per character, low byte first (FL from 11.5 on). A trailing odd byte is ignored. */
export function utf16le(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i + 1 < length; i += 2) {
    text += String.fromCharCode((bytes[offset + i] as number) | ((bytes[offset + i + 1] as number) << 8));
  }
  return text;
}

/** UTF-8 text (VST wrapper records). Malformed sequences become U+FFFD instead of throwing. */
export function utf8(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  const end = offset + length;
  let i = offset;
  while (i < end) {
    const lead = bytes[i++] as number;
    if (lead < 0x80) {
      text += String.fromCharCode(lead);
    } else if (lead >= 0xc0 && lead < 0xe0 && i < end) {
      text += String.fromCharCode(((lead & 0x1f) << 6) | ((bytes[i++] as number) & 0x3f));
    } else if (lead >= 0xe0 && lead < 0xf0 && i + 1 < end) {
      const second = (bytes[i] as number) & 0x3f;
      const third = (bytes[i + 1] as number) & 0x3f;
      text += String.fromCharCode(((lead & 0x0f) << 12) | (second << 6) | third);
      i += 2;
    } else if (lead >= 0xf0 && i + 2 < end) {
      const second = (bytes[i] as number) & 0x3f;
      const third = (bytes[i + 1] as number) & 0x3f;
      const fourth = (bytes[i + 2] as number) & 0x3f;
      const codePoint = ((lead & 0x07) << 18) | (second << 12) | (third << 6) | fourth;
      i += 3;
      text += String.fromCodePoint(Math.min(codePoint, 0x10ffff));
    } else {
      text += '�';
    }
  }
  return text;
}

/** Drops trailing NULs and control characters (keeps tabs and line breaks). */
export function cleanText(text: string): string {
  let out = '';
  for (const char of text.replace(/\0+$/, '')) {
    const code = char.charCodeAt(0);
    if (code >= 0x20 || code === 9 || code === 10 || code === 13) out += char;
  }
  return out.trim();
}

/** Major.minor ≥ 11.5 stores text as UTF-16LE. */
export function isUnicodeVersion(versionParts: number[]): boolean {
  const [major = 0, minor = 0] = versionParts;
  return major > 11 || (major === 11 && minor >= 5);
}

/** Whether `parts` ≥ `min` (lexicographic). */
export function flpVersionAtLeast(parts: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const actual = parts[i] ?? 0;
    const required = min[i] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}
