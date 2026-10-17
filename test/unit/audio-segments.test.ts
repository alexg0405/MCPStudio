import { describe, expect, it } from 'vitest';
import { Mp3StreamEncoder } from '@app/export/mp3';
import { readAudioInfo } from '@core/io/audio-info';
import { byteReaderOf, indexMp3, readWavFrames, readWavLayout, sniffSegmentFormat } from '@core/io/audio-segments';
import { encodeWav } from '@core/io/wav';

const SR = 44100;

function signal(seconds: number, rate = SR): Float32Array[] {
  const n = Math.round(seconds * rate);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = 0.4 * Math.sin((2 * Math.PI * (300 + 5 * (i / rate)) * i) / rate);
    r[i] = 0.3 * Math.sin((2 * Math.PI * 500 * i) / rate);
  }
  return [l, r];
}

function mp3Of(sig: Float32Array[], tagged = true): Uint8Array {
  const enc = new Mp3StreamEncoder(2, SR, 128);
  const parts: Uint8Array[] = [enc.header()];
  for (let i = 0; i < sig[0]!.length; i += SR) parts.push(enc.push([sig[0]!.subarray(i, i + SR), sig[1]!.subarray(i, i + SR)]));
  parts.push(enc.finish());
  const fin = enc.finalHeader();
  if (fin) parts[0] = fin;
  if (!tagged) parts.shift();
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('sniffSegmentFormat', () => {
  it('knows WAV and MP3 from the first bytes and nothing else', () => {
    const wav = encodeWav(signal(0.1), SR, { bitDepth: 16 });
    expect(sniffSegmentFormat(wav)).toBe('wav');
    expect(sniffSegmentFormat(mp3Of(signal(0.5)))).toBe('mp3');
    expect(sniffSegmentFormat(new TextEncoder().encode('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000hello world'))).toBe('mp3');
    expect(sniffSegmentFormat(new TextEncoder().encode('OggS\u0000\u0002\u0000\u0000\u0000\u0000\u0000\u0000'))).toBeNull();
    expect(sniffSegmentFormat(new Uint8Array(4))).toBeNull();
  });
});

describe('WAV by ranges', () => {
  for (const bitDepth of [16, 24, 32] as const) {
    it(`reads any stretch of a ${bitDepth}-bit file exactly as decoding it whole does`, async () => {
      const sig = signal(3);
      const bytes = encodeWav(sig, SR, { bitDepth });
      const r = byteReaderOf(bytes);
      const w = (await readWavLayout(r))!;
      expect(w.sampleRate).toBe(SR);
      expect(w.channels).toBe(2);
      expect(w.frames).toBe(sig[0]!.length);
      for (const [start, n] of [
        [0, 1000],
        [12345, 65536],
        [w.frames - 500, 2000],
      ] as const) {
        const [l, rr] = await readWavFrames(r, w, start, n);
        const want = Math.min(n, w.frames - start);
        expect(l.length).toBe(want);
        for (let i = 0; i < want; i += 97) {
          expect(Math.abs(l[i]! - sig[0]![start + i]!)).toBeLessThan(bitDepth === 16 ? 1e-4 : 1e-6);
          expect(Math.abs(rr![i]! - sig[1]![start + i]!)).toBeLessThan(bitDepth === 16 ? 1e-4 : 1e-6);
        }
      }
    });
  }

  it('reads a mono file as one channel twice, skips metadata before the audio, and refuses what decodePcm cannot read', async () => {
    const sig = signal(1);
    const wav = encodeWav([sig[0]!], SR, { bitDepth: 16 });
    // A LIST chunk (and its pad) between fmt and data.
    const at = 12 + 8 + 16;
    const list = new Uint8Array(8 + 6);
    list.set(new TextEncoder().encode('LIST'));
    new DataView(list.buffer).setUint32(4, 6, true);
    const withList = new Uint8Array(wav.length + list.length);
    withList.set(wav.subarray(0, at));
    withList.set(list, at);
    withList.set(wav.subarray(at), at + list.length);
    const r = byteReaderOf(withList);
    const w = (await readWavLayout(r))!;
    expect(w.channels).toBe(1);
    expect(w.frames).toBe(SR);
    const [l, rr] = await readWavFrames(r, w, 5000, 100);
    expect(l).toBe(rr);
    expect(Math.abs(l[10]! - sig[0]![5010]!)).toBeLessThan(1e-4);
    // µ-law (format 7) is not PCM.
    const bad = wav.slice();
    new DataView(bad.buffer).setUint16(20, 7, true);
    expect(await readWavLayout(byteReaderOf(bad))).toBeNull();
    expect(await readWavLayout(byteReaderOf(new Uint8Array(100)))).toBeNull();
  });
});

describe('indexMp3', () => {
  it('finds every frame, skips the Info frame, and reads LAME’s gapless numbers', async () => {
    const sig = signal(12);
    const bytes = mp3Of(sig);
    const lay = (await indexMp3(byteReaderOf(bytes)))!;
    expect(lay.sampleRate).toBe(SR);
    expect(lay.channels).toBe(2);
    expect(lay.samplesPerFrame).toBe(1152);
    // 128 kbps at 44.1 kHz: 417 or 418 bytes a frame, back to back to the end.
    for (let i = 1; i < lay.count; i++) expect([417, 418]).toContain(lay.offsets[i]! - lay.offsets[i - 1]!);
    expect(lay.offsets[lay.count]).toBe(bytes.length);
    // delay 576 + 529 of the decoder, and the length the header counts says.
    expect(lay.skip).toBe(1105);
    const info = readAudioInfo(bytes)!;
    expect(lay.frames / SR).toBeCloseTo(info.durationSec, 9);
    expect(Math.abs(lay.frames - sig[0]!.length)).toBeLessThan(2);
  });

  it('works without a tag (no gapless numbers: nothing is skipped), after an ID3 tag, and over a trailing tag', async () => {
    const sig = signal(4);
    const plain = mp3Of(sig, false);
    const a = (await indexMp3(byteReaderOf(plain)))!;
    expect(a.skip).toBe(0);
    expect(a.offsets[0]).toBe(0);
    // An ID3v2 tag in front (10 byte header, 20 bytes of frames) and an ID3v1 tag behind.
    const id3 = new Uint8Array(30);
    id3.set(new TextEncoder().encode('ID3'));
    id3[3] = 4;
    id3[9] = 20;
    const v1 = new Uint8Array(128);
    v1.set(new TextEncoder().encode('TAG'));
    const wrapped = new Uint8Array(id3.length + plain.length + v1.length);
    wrapped.set(id3);
    wrapped.set(plain, id3.length);
    wrapped.set(v1, id3.length + plain.length);
    const b = (await indexMp3(byteReaderOf(wrapped)))!;
    expect(b.count).toBe(a.count);
    expect(b.offsets[0]).toBe(30);
    expect(b.offsets[b.count]).toBe(30 + plain.length);
  });

  it('is null for a file that is not MP3 (and for a lone junk header)', async () => {
    expect(await indexMp3(byteReaderOf(new Uint8Array(5000)))).toBeNull();
    expect(await indexMp3(byteReaderOf(encodeWav(signal(0.2), SR, { bitDepth: 16 })))).toBeNull();
  });
});
