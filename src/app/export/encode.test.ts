import { describe, expect, it } from 'vitest';
import { decodeFlac } from '@core/io/flac';
import { mpegFrameAt, readAudioInfo } from '@core/io/audio-info';
import { crc16, parseInfoFrame } from '@core/io/mp3-gapless';
import { decodePcm } from '@core/io/wav';
import { memorySink } from '@platform/sinks';
import { effectiveRate, exportFileName } from './audio-export';
import { createPieceEncoder, encodeAudioAsync } from './encode';

const SR = 44100;
const tone = (seconds: number) =>
  new Float32Array(Math.round(seconds * SR)).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR));

describe('export encoding', () => {
  it('writes WAV, FLAC and MP3 files', async () => {
    const audio = [tone(1), tone(1)];
    const wav = await encodeAudioAsync(audio, SR, { codec: 'wav', bits: 24, kbps: 0 });
    expect(decodePcm(wav)?.channels[0]?.length).toBe(SR);
    const flac = await encodeAudioAsync(audio, SR, { codec: 'flac', bits: 16, kbps: 0 });
    expect(decodeFlac(flac)).toMatchObject({ sampleRate: SR, bitDepth: 16, md5Ok: true });
    const mp3 = await encodeAudioAsync(audio, SR, { codec: 'mp3', bits: 16, kbps: 128 });
    // An MPEG-1 Layer III frame sync, and about 16 kB per second at 128 kbps.
    expect(mp3[0]).toBe(0xff);
    expect((mp3[1] as number) & 0xe0).toBe(0xe0);
    expect(mp3.length).toBeGreaterThan(14000);
    expect(mp3.length).toBeLessThan(19000);
  });

  it('names files and keeps MP3 at a rate it can hold', () => {
    expect(exportFileName('My Song.agproj', 'flac')).toBe('My Song.flac');
    expect(exportFileName('Beat', 'wav', { insertId: 'x' as never, name: '03 Drums', channels: [] })).toBe(
      'Beat - 03 Drums.wav',
    );
    expect(effectiveRate({ codec: 'mp3', sampleRate: 96000 })).toBe(48000);
    expect(effectiveRate({ codec: 'mp3', sampleRate: 44100 })).toBe(44100);
    expect(effectiveRate({ codec: 'wav', sampleRate: 96000 })).toBe(96000);
  });
});

describe('gapless MP3 header', () => {
  /** Walks the frames from the start the way a decoder does. */
  const walk = (mp3: Uint8Array) => {
    let o = 0;
    let frames = 0;
    for (;;) {
      const f = mpegFrameAt(mp3, o);
      if (!f) break;
      frames++;
      o += f.length;
    }
    return { frames, end: o };
  };

  it.each([
    { channels: 2, rate: 44100, kbps: 128, seconds: 1.37 },
    { channels: 2, rate: 48000, kbps: 320, seconds: 0.5 },
    { channels: 1, rate: 44100, kbps: 192, seconds: 0.9 },
  ])('starts with an Info frame holding the delay and padding ($channels ch, $rate Hz, $kbps kbps)', async ({ channels, rate, kbps, seconds }) => {
    const n = Math.round(seconds * rate);
    const audio = Array.from({ length: channels }, () => new Float32Array(n).map((_, i) => 0.4 * Math.sin((2 * Math.PI * 440 * i) / rate)));
    const mp3 = await encodeAudioAsync(audio, rate, { codec: 'mp3', bits: 16, kbps });
    const info = parseInfoFrame(mp3);
    expect(info).not.toBeNull();
    // A frame sync first, and "Info" (constant bit rate) where a Xing header would be.
    expect(mp3[0]).toBe(0xff);
    expect((mp3[1] as number) & 0xe0).toBe(0xe0);
    expect(info).toMatchObject({ tag: 'Info', kbps, sampleRate: rate, channels });
    expect(info!.frameBytes).toBe(Math.floor((144000 * kbps) / rate));
    // Every frame after the Info frame is counted, and the bytes are the whole file.
    const { frames, end } = walk(mp3);
    expect(end).toBe(mp3.length);
    expect(info!.frames).toBe(frames - 1);
    expect(info!.bytes).toBe(mp3.length);
    expect(info!.toc).toHaveLength(100);
    // Delay is LAME's 576; delay + samples + padding fills the frames exactly.
    expect(info!.lame).toMatchObject({ delay: 576, tagCrcOk: true, musicBytes: mp3.length });
    expect(576 + n + info!.lame!.padding).toBe(info!.frames * 1152);
    expect(info!.lame!.padding).toBeGreaterThanOrEqual(0);
    expect(info!.lame!.musicCrc).toBe(crc16(mp3.subarray(info!.frameBytes)));
    // The length reader sees the exact length of the audio that went in.
    const read = readAudioInfo(mp3);
    expect(read).toMatchObject({ format: 'mp3', exact: true, sampleRate: rate, channels });
    expect(read!.durationSec * rate).toBeCloseTo(n, 3);
  });

  it('streams: the placeholder is a valid frame, and patching it gives the same file as encoding at once', async () => {
    const n = 44100 * 2 + 313;
    const audio = [0, 1].map((c) => new Float32Array(n).map((_, i) => 0.3 * Math.sin((2 * Math.PI * (330 + 110 * c) * i) / 44100)));
    const whole = await encodeAudioAsync(audio.map((a) => a.slice()), 44100, { codec: 'mp3', bits: 16, kbps: 160 });
    const enc = await createPieceEncoder({ codec: 'mp3', bits: 16, kbps: 160 }, 44100, 2);
    const sink = memorySink();
    await sink.write(enc.header());
    const placeholder = parseInfoFrame(enc.header())!;
    expect(placeholder).toMatchObject({ tag: 'Info', frames: 0 });
    for (const [a, b] of [[0, 1000], [1000, 50000], [50000, n]] as const) await sink.write(enc.push(audio.map((c) => c.slice(a, b))));
    await sink.write(enc.finish());
    // Before the patch the file is already a playable stream (every frame found).
    expect(walk(sink.bytes().slice()).end).toBe(sink.size);
    await sink.writeAt(0, enc.finalHeader()!);
    expect(sink.bytes()).toEqual(whole);
  });

  it('gives a short file a header too', async () => {
    const mp3 = await encodeAudioAsync([new Float32Array(10)], 48000, { codec: 'mp3', bits: 16, kbps: 128 });
    const info = parseInfoFrame(mp3)!;
    expect(info.frames).toBe(walk(mp3).frames - 1);
    expect(576 + 10 + info.lame!.padding).toBe(info.frames * 1152);
  });
});
