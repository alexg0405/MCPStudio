import { describe, expect, it } from 'vitest';
import { decodePcm16, encodePcm16, readPcm16Info } from './pcm16';

describe('PCM16 container', () => {
  it('round-trips within half a step, deterministically', () => {
    const a = new Float32Array(1000).map((_, i) => Math.sin(i / 7) * 0.8);
    const b = new Float32Array(1000).map((_, i) => Math.cos(i / 5) * 0.3);
    const bytes = encodePcm16([a, b], 44100);
    expect(bytes).toEqual(encodePcm16([a, b], 44100));
    const back = decodePcm16(bytes)!;
    expect(back.info).toEqual({ channels: 2, sampleRate: 44100, frames: 1000, gain: 1 });
    for (let i = 0; i < 1000; i++) {
      expect(Math.abs(back.channels[0]![i]! - a[i]!)).toBeLessThanOrEqual(0.5 / 32767 + 1e-7);
      expect(Math.abs(back.channels[1]![i]! - b[i]!)).toBeLessThanOrEqual(0.5 / 32767 + 1e-7);
    }
  });

  it("keeps audio over full scale (a gain in the header) and reads from an odd offset", () => {
    const x = new Float32Array([0, 1.5, -1.5, 0.75]);
    const bytes = encodePcm16([x], 48000);
    const odd = new Uint8Array(bytes.length + 1);
    odd.set(bytes, 1);
    const back = decodePcm16(odd.subarray(1))!;
    expect(back.info.gain).toBeCloseTo(1.5, 6);
    expect([...back.channels[0]!].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 1.5, -1.5, 0.75]);
  });

  it('rejects other and truncated bytes', () => {
    expect(readPcm16Info(new Uint8Array(30))).toBeNull();
    const bytes = encodePcm16([new Float32Array(10)], 48000);
    expect(readPcm16Info(bytes.subarray(0, bytes.length - 2))).toBeNull();
  });
});
