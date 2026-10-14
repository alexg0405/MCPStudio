/**
 * FLAC export: Chrome's own decoder (decodeAudioData) reads our FLAC files back bit-exactly, at 16
 * and 24 bits, for a real render and for synthetic signals (M15).
 */
import { describe, expect, it } from 'vitest';
import { encodeFlac } from '@core/io/flac';
import { quantizePcm } from '@core/io/wav';
import { renderOffline } from '@engine/render-offline';
import { trimRender } from '@app/export/export-wav';
import { kitProject, resolver } from '../helpers/fixtures';
import { harmonicTone } from '../helpers/audio';

const SR = 48000;

async function decode(bytes: Uint8Array): Promise<AudioBuffer> {
  return new OfflineAudioContext(2, 1, SR).decodeAudioData(bytes.slice().buffer as ArrayBuffer);
}

/**
 * The float Chrome gives an integer sample. Its decoder (FFmpeg) hands over 16-bit FLAC as int16 and
 * 24-bit FLAC as int32 (the sample shifted up by 8), and Chrome scales integers asymmetrically, in
 * float32: positive values times (1 / max), negative ones divided by −min. So "bit-exact" means
 * exactly this float (for 24-bit it is v / 2^23: 1 / (2^31 − 1) rounds to 2^−31 in float32).
 */
function chromeFloat(v: number, bits: 16 | 24): number {
  const max = bits === 16 ? 32767 : 2147483647;
  const s = bits === 16 ? v : v * 256;
  return s > 0 ? Math.fround(s * Math.fround(1 / max)) : s / (max + 1);
}

function expectExact(decoded: AudioBuffer, pcm: Int32Array[], bits: 16 | 24): void {
  expect(decoded.numberOfChannels).toBe(pcm.length);
  expect(decoded.length).toBe(pcm[0]!.length);
  for (let c = 0; c < pcm.length; c++) {
    const got = decoded.getChannelData(c);
    const want = pcm[c] as Int32Array;
    let bad = 0;
    for (let i = 0; i < want.length; i++) if (got[i] !== chromeFloat(want[i] as number, bits)) bad++;
    expect(bad).toBe(0);
  }
}

describe('FLAC export', () => {
  it('decodes back bit-exactly at 16 and 24 bits (a kit render)', async () => {
    const { project, patternId } = kitProject(
      [
        { generator: 'kit/kick', steps: [0, 4, 8, 12] },
        { generator: 'kit/snare', steps: [4, 12] },
        { generator: 'kit/hat-closed', steps: [2, 6, 10, 14] },
      ],
      124,
    );
    const r = await renderOffline(project, {
      plugins: resolver(),
      view: { mode: 'pattern', patternId, loop: null },
      bars: 2,
      sampleRate: SR,
      tail: 'auto',
    });
    const channels = trimRender(r.buffer, r.preRoll, (2 * 4 * 60) / 124);
    for (const bits of [16, 24] as const) {
      const dither = bits === 16;
      const flac = encodeFlac(channels, SR, { bitDepth: bits, dither, seed: 11 });
      expectExact(await decode(flac), quantizePcm(channels, bits, { dither, seed: 11 }), bits);
    }
  });

  it('decodes back bit-exactly for tones, silence and full-scale signals, mono and stereo', async () => {
    const tone = harmonicTone(220, 1.1, SR, 0.9);
    const loud = new Float32Array(SR).map((_, i) => (Math.floor(i / 50) % 2 ? 1 : -1));
    const cases: Float32Array[][] = [[tone, tone.slice().reverse()], [loud, new Float32Array(SR)], [tone]];
    for (const channels of cases)
      for (const bits of [16, 24] as const) {
        const flac = encodeFlac(channels, SR, { bitDepth: bits });
        expectExact(await decode(flac), quantizePcm(channels, bits), bits);
      }
  });
});
