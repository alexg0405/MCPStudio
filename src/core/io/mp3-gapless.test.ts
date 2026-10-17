import { describe, expect, it } from 'vitest';
import { buildInfoFrame, crc16, gaplessPadding, infoFrameBytes, Mp3StreamCounter, nearestMp3Bitrate, parseInfoFrame } from './mp3-gapless';

describe('MP3 Info frame', () => {
  it('round-trips the counts, delay and padding', () => {
    const frame = buildInfoFrame({ kbps: 128, sampleRate: 44100, channels: 2, frames: 100, audioBytes: 41800, samples: 114000, musicCrc: 0xbeef });
    expect(frame).toHaveLength(417);
    expect(infoFrameBytes(128, 44100, 2)).toBe(417);
    const info = parseInfoFrame(frame)!;
    expect(info).toMatchObject({ tag: 'Info', kbps: 128, sampleRate: 44100, channels: 2, frames: 100, bytes: 417 + 41800 });
    expect(info.lame).toMatchObject({ version: 'LAME3.98 ', delay: 576, padding: 100 * 1152 - 114000 - 576, musicCrc: 0xbeef, tagCrcOk: true });
    // The silent frame's side information is zero.
    expect([...frame.subarray(4, 36)].every((b) => b === 0)).toBe(true);
    // The first 4 bytes are a Layer III frame header with no padding slot.
    expect([frame[0], frame[1]]).toEqual([0xff, 0xfb]);
    expect((frame[2] as number) & 2).toBe(0);
  });

  it('puts the tag where a mono stream has it, and can be damaged without the CRC agreeing', () => {
    const frame = buildInfoFrame({ kbps: 192, sampleRate: 48000, channels: 1, frames: 10, audioBytes: 5760, samples: 11000, musicCrc: 1 });
    expect(String.fromCharCode(...frame.subarray(21, 25))).toBe('Info');
    expect(parseInfoFrame(frame)).toMatchObject({ channels: 1, frames: 10 });
    frame[100] = 7;
    expect(parseInfoFrame(frame)!.lame!.tagCrcOk).toBe(false);
  });

  it('copies the mode of the first audio frame but never its padding slot', () => {
    const first = Uint8Array.of(0xff, 0xfb, 0x90 | 0x02, 0x44);
    const frame = buildInfoFrame({ kbps: 128, sampleRate: 44100, channels: 2, frames: 1, audioBytes: 0, samples: 0, musicCrc: 0, firstHeader: first });
    expect([frame[2], frame[3]]).toEqual([0x90, 0x44]);
  });

  it('has no frame for a bit rate too low to hold the tag', () => {
    expect(infoFrameBytes(32, 48000, 2)).toBe(0);
    expect(() => buildInfoFrame({ kbps: 32, sampleRate: 48000, channels: 2, frames: 1, audioBytes: 0, samples: 0, musicCrc: 0 })).toThrow(RangeError);
  });

  it('computes padding so delay + samples + padding fills the frames', () => {
    expect(gaplessPadding(10, 10000)).toBe(10 * 1152 - 10000 - 576);
    expect(gaplessPadding(0, 0)).toBe(0);
    expect(nearestMp3Bitrate(130)).toBe(128);
    expect(nearestMp3Bitrate(999)).toBe(320);
  });

  it('crc16 is the reflected 0x8005 CRC ("123456789" gives 0xBB3D)', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0xbb3d);
  });
});

describe('Mp3StreamCounter', () => {
  it('counts frames and bytes however the stream is cut up', () => {
    // 5 frames at 128 kbps, 44.1 kHz: 417 bytes, the 2nd and 4th with a padding slot (418).
    const lengths = [417, 418, 417, 418, 417];
    const stream = new Uint8Array(lengths.reduce((a, b) => a + b, 0));
    let o = 0;
    for (const [i, n] of lengths.entries()) {
      stream.set([0xff, 0xfb, 0x90 | (n === 418 ? 2 : 0), 0x40], o);
      for (let k = 4; k < n; k++) stream[o + k] = (i * 31 + k) & 0xff;
      o += n;
    }
    for (const cut of [1, 2, 3, 4, 5, 100, 416, 417, 418, 1000, stream.length]) {
      const c = new Mp3StreamCounter(44100);
      for (let a = 0; a < stream.length; a += cut) c.add(stream.subarray(a, a + cut));
      expect(c.frames, `cut ${cut}`).toBe(5);
      expect(c.bytes).toBe(stream.length);
      expect(c.crc).toBe(crc16(stream));
      expect([...c.firstHeader!]).toEqual([0xff, 0xfb, 0x90, 0x40]);
    }
  });
});
