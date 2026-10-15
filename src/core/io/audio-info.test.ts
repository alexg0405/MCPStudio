import { describe, expect, it } from 'vitest';
import { readAudioInfo } from './audio-info';
import { encodeFlac } from './flac';
import { encodeWav } from './wav';

// Tiny synthetic files: just the headers (and frame headers) each parser reads.

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const cat = (...parts: (number[] | Uint8Array)[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** An MPEG-1 Layer III frame header (128 kbps, 44.1 kHz, stereo unless mono) and its zeroed body. */
function mp3Frame(opts: { kbpsIdx?: number; mono?: boolean; pad?: boolean } = {}): Uint8Array {
  const idx = opts.kbpsIdx ?? 9; // 128 kbps
  const kbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][idx]!;
  const len = Math.floor((144000 * kbps) / 44100) + (opts.pad ? 1 : 0);
  const f = new Uint8Array(len);
  f.set([0xff, 0xfb, (idx << 4) | (0 << 2) | ((opts.pad ? 1 : 0) << 1), opts.mono ? 0xc0 : 0x00]);
  return f;
}

function id3(size: number): number[] {
  return [...ascii('ID3'), 4, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127, ...new Array(size).fill(0)];
}

describe('readAudioInfo', () => {
  it('reads WAV (and a data size that runs past the end)', () => {
    const wav = encodeWav([new Float32Array(4410), new Float32Array(4410)], 44100, { bitDepth: 16 });
    expect(readAudioInfo(wav)).toEqual({ format: 'wav', durationSec: 0.1, sampleRate: 44100, channels: 2, exact: true });
    const cut = wav.subarray(0, wav.length - 400);
    expect(readAudioInfo(cut)!.durationSec).toBeCloseTo((4410 - 100) / 44100, 9);
  });

  it('reads AIFF (COMM with an 80-bit sample rate)', () => {
    // 48000 as an extended float: exponent 16383 + 15, mantissa 48000 << 48.
    const rate = [0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0];
    const comm = [...ascii('COMM'), ...be32(18), 0, 1, ...be32(96000), 0, 16, ...rate];
    const aiff = cat(ascii('FORM'), be32(4 + comm.length), ascii('AIFF'), comm);
    expect(readAudioInfo(aiff)).toEqual({ format: 'aiff', durationSec: 2, sampleRate: 48000, channels: 1, exact: true });
  });

  it('reads FLAC STREAMINFO, after an ID3 tag too', () => {
    const flac = encodeFlac([new Float32Array(12000), new Float32Array(12000)], 48000, { bitDepth: 16 });
    expect(readAudioInfo(flac)).toEqual({ format: 'flac', durationSec: 0.25, sampleRate: 48000, channels: 2, exact: true });
    expect(readAudioInfo(cat(id3(20), flac))!.durationSec).toBe(0.25);
  });

  it('reads an MP3 Xing header with LAME delay and padding', () => {
    const xingFrame = mp3Frame();
    const x = 4 + 32;
    xingFrame.set([...ascii('Info'), ...be32(1), ...be32(1000)], x);
    // LAME tag right after the frame count: delay 576, padding 1000 at byte 21.
    xingFrame.set([...ascii('LAME3.100')], x + 12);
    xingFrame.set([(576 >> 4) & 255, ((576 & 15) << 4) | (1000 >> 8), 1000 & 255], x + 12 + 21);
    const file = cat(id3(100), xingFrame, mp3Frame(), mp3Frame());
    const info = readAudioInfo(file)!;
    expect(info).toMatchObject({ format: 'mp3', sampleRate: 44100, channels: 2, exact: true });
    expect(info.durationSec).toBeCloseTo((1000 * 1152 - 576 - 1000) / 44100, 9);
  });

  it('reads an MP3 VBRI header', () => {
    const f = mp3Frame({ kbpsIdx: 14 });
    f.set([...ascii('VBRI'), 0, 1, 0, 100, 0, 50, ...be32(123456), ...be32(500)], 36);
    const info = readAudioInfo(cat(f, mp3Frame()))!;
    expect(info.durationSec).toBeCloseTo((500 * 1152 - 100) / 44100, 9);
  });

  it('counts MP3 frames when there is no header (padding, a broken frame and an ID3v1 tag)', () => {
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 300; i++) frames.push(mp3Frame({ pad: i % 3 === 0, mono: true }));
    frames.splice(150, 0, new Uint8Array([1, 2, 3, 4, 5])); // junk between frames
    const file = cat(...frames, ascii('TAG'), new Array(125).fill(0));
    const info = readAudioInfo(file)!;
    expect(info).toMatchObject({ format: 'mp3', channels: 1, sampleRate: 44100, exact: false });
    expect(info.durationSec).toBeCloseTo((300 * 1152) / 44100, 9);
  });

  it('counts ADTS AAC frames', () => {
    const frame = (len: number) => {
      const f = new Uint8Array(len);
      // MPEG-4, no CRC; AAC LC; 44.1 kHz (index 4); 2 channels; one raw data block.
      f.set([0xff, 0xf1, (1 << 6) | (4 << 2) | 0, (2 << 6) | ((len >> 11) & 3), (len >> 3) & 255, ((len & 7) << 5) | 0x1f, 0xfc]);
      return f;
    };
    const file = cat(...Array.from({ length: 431 }, (_, i) => frame(200 + (i % 7))));
    const info = readAudioInfo(file)!;
    expect(info).toMatchObject({ format: 'aac', sampleRate: 44100, channels: 2 });
    expect(info.durationSec).toBeCloseTo((431 * 1024) / 44100, 9);
  });

  it('reads M4A: the sound track’s mdhd and its mp4a sample entry', () => {
    const box = (type: string, ...body: (number[] | Uint8Array)[]) => {
      const b = cat(...body);
      return cat(be32(8 + b.length), ascii(type), b);
    };
    const mdhd = box('mdhd', [0, 0, 0, 0], be32(0), be32(0), be32(44100), be32(44100 * 185), [0, 0, 0, 0]);
    const hdlr = box('hdlr', [0, 0, 0, 0], be32(0), ascii('soun'), new Array(12).fill(0), [0]);
    const mp4a = box('mp4a', new Array(6).fill(0), [0, 1], new Array(8).fill(0), [0, 2], [0, 16], [0, 0, 0, 0], be32(44100 * 65536));
    const stsd = box('stsd', [0, 0, 0, 0], be32(1), mp4a);
    const trak = box('trak', box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd))));
    const moov = box('moov', box('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(185_046)), trak);
    const file = cat(box('ftyp', ascii('M4A '), be32(0)), box('mdat', new Array(64).fill(0)), moov);
    expect(readAudioInfo(file)).toEqual({ format: 'm4a', durationSec: 185, sampleRate: 44100, channels: 2, exact: false });
  });

  it('reads OGG Vorbis and Opus (identification header, last granule position)', () => {
    const page = (granule: number, serial: number, packet: number[]) =>
      cat(ascii('OggS'), [0, 0], le32(granule), le32(0), le32(serial), le32(0), le32(0), [1, packet.length], packet);
    const vorbisId = [1, ...ascii('vorbis'), ...le32(0), 2, ...le32(44100), ...new Array(13).fill(0)];
    const vorbis = cat(page(0, 7, vorbisId), page(4096, 7, [1, 2, 3]), page(44100 * 3, 7, [4, 5]), page(999999, 8, [6]));
    expect(readAudioInfo(vorbis)).toEqual({ format: 'ogg', durationSec: 3, sampleRate: 44100, channels: 2, exact: true });
    const opusHead = [...ascii('OpusHead'), 1, 1, 0x38, 0x01, ...le32(44100), 0, 0, 0];
    const opus = cat(page(0, 3, opusHead), page(48000 * 2 + 312, 3, [1]));
    expect(readAudioInfo(opus)).toEqual({ format: 'ogg', durationSec: 2, sampleRate: 48000, channels: 1, exact: true });
  });

  it("says null when it can't tell", () => {
    expect(readAudioInfo(new Uint8Array(100))).toBeNull();
    expect(readAudioInfo(cat(ascii('RIFF'), le32(4), ascii('WAVE')))).toBeNull();
    expect(readAudioInfo(cat(ascii('fLaC'), new Array(40).fill(0)))).toBeNull();
  });
});
