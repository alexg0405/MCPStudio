import { describe, expect, it } from 'vitest';
import { readTags, songTitle } from './tags';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const utf8 = (s: string) => [...Buffer.from(s, 'utf8')];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const synch = (n: number) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];

function id3(frames: [string, number[]][], version = 4): Uint8Array {
  const body = frames.flatMap(([id, data]) => [...ascii(id), ...(version === 4 ? synch(data.length) : be32(data.length)), 0, 0, ...data]);
  return new Uint8Array([...ascii('ID3'), version, 0, 0, ...synch(body.length), ...body, 0xff, 0xfb]);
}

function atom(type: string, body: number[]): number[] {
  return [...be32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];
}

describe('readTags', () => {
  it('reads ID3v2.4 UTF-8 and ID3v2.3 UTF-16 frames', () => {
    expect(readTags(id3([['TIT2', [3, ...utf8('Café Nights')]], ['TPE1', [3, ...utf8('DJ Ü')]]]))).toEqual({ title: 'Café Nights', artist: 'DJ Ü' });
    const u16 = (s: string) => [0xff, 0xfe, ...[...s].flatMap((c) => [c.charCodeAt(0), 0])];
    expect(readTags(id3([['TPE1', [1, ...u16('Artist')]], ['TIT2', [1, ...u16('Song')]]], 3))).toEqual({ title: 'Song', artist: 'Artist' });
  });

  it('reads FLAC Vorbis comments', () => {
    const comment = (s: string) => [...le32(utf8(s).length), ...utf8(s)];
    const block = [...le32(3), ...ascii('ref'), ...le32(2), ...comment('TITLE=Morning'), ...comment('artist=Sun Ra')];
    const bytes = new Uint8Array([...ascii('fLaC'), 0x00, 0, 0, 34, ...new Array(34).fill(0), 0x84, 0, (block.length >> 8) & 255, block.length & 255, ...block]);
    expect(readTags(bytes)).toEqual({ title: 'Morning', artist: 'Sun Ra' });
  });

  it('reads MP4 ilst atoms', () => {
    const data = (s: string) => atom('data', [0, 0, 0, 1, 0, 0, 0, 0, ...utf8(s)]);
    const ilst = atom('ilst', [...atom('©nam', data('Track')), ...atom('©ART', data('Band'))]);
    const moov = atom('moov', atom('udta', atom('meta', [0, 0, 0, 0, ...ilst])));
    const bytes = new Uint8Array([...atom('ftyp', ascii('M4A ')), ...moov].map((v) => v & 255));
    expect(readTags(bytes)).toEqual({ title: 'Track', artist: 'Band' });
  });

  it('gives nothing for files without tags or garbage', () => {
    expect(readTags(new Uint8Array([1, 2, 3]))).toEqual({});
    expect(readTags(new Uint8Array([...ascii('ID3'), 4, 0, 0, 127, 127, 127, 127, 1]))).toEqual({});
  });
});

describe('songTitle', () => {
  it('prefers tags, then "Artist - Title" file names', () => {
    expect(songTitle({ title: 'T', artist: 'A' }, 'x.mp3').label).toBe('A – T');
    expect(songTitle({}, '03 - Daft Punk - One More Time.flac')).toEqual({ title: 'One More Time', artist: 'Daft Punk', label: 'Daft Punk – One More Time' });
    expect(songTitle({}, 'music/My Song.m4a').label).toBe('My Song');
  });
});
