/**
 * Title and artist from a music file's tags, cheaply (no decoding): ID3v2 (MP3, also at the start
 * of some AAC/WAV files), FLAC and Ogg Vorbis comments, MP4/M4A `ilst` atoms. Pure; anything it
 * can't read gives no tags. `songTitle` falls back to the file name ("Artist - Title.mp3").
 */

export interface SongTags {
  title?: string;
  artist?: string;
}

const latin1 = (b: Uint8Array, from: number, to: number) => {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]!);
  return s;
};

/** UTF-8 to a string (core has no TextDecoder); bad bytes become U+FFFD. */
function utf8(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length;) {
    const c = b[i]!;
    const n = c < 0x80 ? 0 : c >> 5 === 6 ? 1 : c >> 4 === 14 ? 2 : c >> 3 === 30 ? 3 : -1;
    if (n < 0 || i + n >= b.length + (n === 0 ? 1 : 0)) {
      s += n === 0 ? String.fromCharCode(c) : '�';
      i++;
      continue;
    }
    let cp = n === 0 ? c : c & (0x3f >> n);
    let ok = true;
    for (let k = 1; k <= n; k++) {
      const x = b[i + k]!;
      if (x >> 6 !== 2) ok = false;
      cp = (cp << 6) | (x & 0x3f);
    }
    s += ok ? String.fromCodePoint(cp) : '�';
    i += ok ? n + 1 : 1;
  }
  return s;
}

function utf16(b: Uint8Array, bigEndian?: boolean): string {
  let i = 0;
  let be = bigEndian ?? false;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    be = false;
    i = 2;
  } else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    be = true;
    i = 2;
  }
  let s = '';
  for (; i + 1 < b.length; i += 2) {
    const c = be ? (b[i]! << 8) | b[i + 1]! : b[i]! | (b[i + 1]! << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

const clean = (s: string | undefined) => {
  const t = s?.replace(/\0+$/g, '').split('\0')[0]?.trim();
  return t ? t.slice(0, 200) : undefined;
};

/** An ID3v2 text frame's payload (its encoding byte first). */
function id3Text(b: Uint8Array): string | undefined {
  const enc = b[0];
  const body = b.subarray(1);
  if (enc === 1) return clean(utf16(body));
  if (enc === 2) return clean(utf16(body, true));
  if (enc === 3) return clean(utf8(body));
  return clean(latin1(body, 0, body.length));
}

const synchsafe = (b: Uint8Array, o: number) =>
  ((b[o]! & 0x7f) << 21) | ((b[o + 1]! & 0x7f) << 14) | ((b[o + 2]! & 0x7f) << 7) | (b[o + 3]! & 0x7f);

function readId3(b: Uint8Array): SongTags | null {
  if (b.length < 10 || latin1(b, 0, 3) !== 'ID3') return null;
  const version = b[3]!;
  const flags = b[5]!;
  const size = synchsafe(b, 6);
  const end = Math.min(b.length, 10 + size);
  let o = 10;
  if (flags & 0x40 && version >= 3)
    o += version === 4 ? synchsafe(b, 10) : ((b[10]! << 24) | (b[11]! << 16) | (b[12]! << 8) | b[13]!) + 4;
  const tags: SongTags = {};
  const idLen = version === 2 ? 3 : 4;
  const headLen = version === 2 ? 6 : 10;
  while (o + headLen <= end) {
    const id = latin1(b, o, o + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const len =
      version === 2
        ? (b[o + 3]! << 16) | (b[o + 4]! << 8) | b[o + 5]!
        : version === 4
          ? synchsafe(b, o + 4)
          : ((b[o + 4]! << 24) | (b[o + 5]! << 16) | (b[o + 6]! << 8) | b[o + 7]!) >>> 0;
    const body = b.subarray(o + headLen, Math.min(end, o + headLen + len));
    if (id === 'TIT2' || id === 'TT2') tags.title ??= id3Text(body);
    if (id === 'TPE1' || id === 'TP1') tags.artist ??= id3Text(body);
    if (len <= 0) break;
    o += headLen + len;
  }
  return tags;
}

/** Vorbis comments (FLAC block 4, Ogg Vorbis/Opus comment packets): little-endian lengths, KEY=value. */
function vorbisComments(b: Uint8Array, o: number, end: number): SongTags {
  const tags: SongTags = {};
  const u32 = (at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
  if (o + 4 > end) return tags;
  o += 4 + u32(o); // vendor
  if (o + 4 > end) return tags;
  const n = u32(o);
  o += 4;
  for (let i = 0; i < n && o + 4 <= end; i++) {
    const len = u32(o);
    o += 4;
    const s = utf8(b.subarray(o, Math.min(end, o + len)));
    o += len;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const k = s.slice(0, eq).toUpperCase();
    if (k === 'TITLE') tags.title ??= clean(s.slice(eq + 1));
    if (k === 'ARTIST') tags.artist ??= clean(s.slice(eq + 1));
  }
  return tags;
}

function readFlac(b: Uint8Array): SongTags | null {
  if (latin1(b, 0, 4) !== 'fLaC') return null;
  let o = 4;
  while (o + 4 <= b.length) {
    const head = b[o]!;
    const len = (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!;
    if ((head & 0x7f) === 4) return vorbisComments(b, o + 4, Math.min(b.length, o + 4 + len));
    if (head & 0x80) break;
    o += 4 + len;
  }
  return {};
}

function readOgg(b: Uint8Array): SongTags | null {
  if (latin1(b, 0, 4) !== 'OggS') return null;
  // The comment packet is in the first few pages: find its signature.
  const limit = Math.min(b.length, 1 << 16);
  for (let i = 0; i + 8 < limit; i++) {
    if (b[i] === 0x03 && latin1(b, i + 1, i + 7) === 'vorbis') return vorbisComments(b, i + 7, limit);
    if (latin1(b, i, i + 8) === 'OpusTags') return vorbisComments(b, i + 8, limit);
  }
  return {};
}

function readMp4(b: Uint8Array): SongTags | null {
  if (latin1(b, 4, 8) !== 'ftyp') return null;
  const u32 = (at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
  const tags: SongTags = {};
  const walk = (from: number, to: number, depth: number) => {
    let o = from;
    while (o + 8 <= to && depth < 8) {
      let size = u32(o);
      const type = latin1(b, o + 4, o + 8);
      let head = 8;
      if (size === 1 && o + 16 <= to) {
        size = u32(o + 12); // 64-bit sizes: files under 4 GB
        head = 16;
      }
      if (size === 0) size = to - o;
      if (size < head || o + size > to) break;
      const body = o + head;
      if (type === 'moov' || type === 'udta' || type === 'ilst') walk(body, o + size, depth + 1);
      else if (type === 'meta') walk(body + 4, o + size, depth + 1);
      else if (type === '©nam' || type === '©ART') {
        // Its 'data' atom: size, 'data', 4 bytes type, 4 bytes locale, the text.
        if (latin1(b, body + 4, body + 8) === 'data') {
          const text = clean(utf8(b.subarray(body + 16, Math.min(o + size, body + u32(body)))));
          if (type === '©nam') tags.title ??= text;
          else tags.artist ??= text;
        }
      }
      o += size;
    }
  };
  walk(0, b.length, 0);
  return tags;
}

/** The tags of a music file (its whole bytes, or at least the part that holds the tags). */
export function readTags(bytes: Uint8Array): SongTags {
  try {
    return readId3(bytes) ?? readFlac(bytes) ?? readOgg(bytes) ?? readMp4(bytes) ?? {};
  } catch {
    return {};
  }
}

/** "Artist – Title" from tags, else from the file name ("01 - Artist - Title.mp3" → "Artist – Title"). */
export function songTitle(tags: SongTags, fileName: string): { title: string; artist?: string; label: string } {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  if (tags.title) {
    const label = tags.artist ? `${tags.artist} – ${tags.title}` : tags.title;
    return { title: tags.title, ...(tags.artist ? { artist: tags.artist } : {}), label };
  }
  const parts = base
    .replace(/^\d{1,3}[\s._-]+/, '')
    .split(/\s+[-–—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const artist = parts[0]!;
    const title = parts.slice(1).join(' – ');
    return { title, artist, label: `${artist} – ${title}` };
  }
  const title = parts[0] ?? (base || 'Song');
  return { title, label: title };
}
