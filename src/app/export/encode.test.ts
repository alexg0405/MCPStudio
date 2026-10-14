import { describe, expect, it } from 'vitest';
import { decodeFlac } from '@core/io/flac';
import { decodePcm } from '@core/io/wav';
import { effectiveRate, exportFileName } from './audio-export';
import { encodeAudioAsync } from './encode';

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
