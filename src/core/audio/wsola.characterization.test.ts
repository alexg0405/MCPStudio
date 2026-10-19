/**
 * Characterization of the time stretch: a hash of every output sample (exact float bits) for a spread
 * of signals (a held tone, clicks over a tone, noise bursts, stereo and three channels), scales, sample
 * rates and options, plus the attacks `detectOnsets` finds. The stretch is DSP that must stay
 * bit-for-bit what it was while its code is reorganised.
 *
 * If a deliberate change makes it fail, review the cause and regenerate the snapshot with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { harmonicTone, sine } from '../../../test/helpers/audio';
import { sha256Hex } from '../io/hash';
import { detectOnsets, stretchStream, timeStretch, type StretchOptions } from './wsola';

/** Uniform noise in [−1, 1) from a seed (mulberry32). */
function noise(length: number, seed: number): Float32Array {
  let a = seed >>> 0;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  return out;
}

/** A quiet tone with a decaying click every `everySec` seconds (drum-like attacks of different strengths). */
function clickBed(sampleRate: number, seconds: number, everySec: number, seed: number): Float32Array {
  const x = sine(110, seconds, sampleRate, 0.05);
  const jitter = noise(64, seed);
  let n = 0;
  for (let t = 0.2; t < seconds - 0.2; t += everySec) {
    const at = Math.round(t * sampleRate);
    const gain = 0.4 + 0.6 * Math.abs(jitter[n++ % 64] as number);
    for (let k = 0; k < 0.006 * sampleRate; k++) {
      x[at + k] = (x[at + k] as number) + gain * Math.exp(-k / (0.001 * sampleRate)) * (k % 2 ? -1 : 1);
    }
  }
  return x;
}

async function hashOf(channels: readonly Float32Array[]): Promise<string> {
  const parts = await Promise.all(channels.map((c) => sha256Hex(new Uint8Array(c.buffer, c.byteOffset, c.byteLength))));
  return parts.map((p) => p.slice(0, 12)).join(' ');
}

describe('time stretch characterization', () => {
  it('produces the same samples for every signal, scale and option', async () => {
    const lines: string[] = [];
    const run = async (label: string, channels: Float32Array[], scale: number, opts: StretchOptions) => {
      const out = timeStretch(channels, scale, opts);
      lines.push(`${label} x${scale}: ${out[0]?.length ?? 0} frames ${await hashOf(out)}`);
    };
    const SR = 48000;
    const tone = harmonicTone(220, 1.2, SR);
    const bed = clickBed(SR, 2.4, 0.37, 3);
    const burst = noise(Math.round(1.5 * SR), 7);
    for (let i = 0; i < burst.length; i++) {
      burst[i] =
        (burst[i] as number) *
        Math.max(0, Math.sin((Math.PI * i) / (0.3 * SR)) ** 3) *
        (i % (SR / 2) < 0.2 * SR ? 1 : 0.02);
    }
    for (const scale of [0.5, 0.75, 1, 1.25, 1.6, 2]) await run('tone', [tone], scale, { sampleRate: SR });
    for (const scale of [0.6, 0.9, 1.3, 2.2]) await run('clicks', [bed], scale, { sampleRate: SR });
    for (const scale of [0.6, 0.9, 1.3, 2.2])
      await run('clicks, no transient mode', [bed], scale, { sampleRate: SR, transients: false });
    for (const scale of [0.8, 1.4]) await run('noise bursts', [burst], scale, { sampleRate: SR });
    await run('stereo', [bed, tone.slice(0, bed.length).map((v, i) => v * 0.5 + (bed[i] as number) * 0.2)], 1.15, {
      sampleRate: SR,
    });
    await run('three channels', [bed, burst.slice(0, bed.length), tone], 0.85, { sampleRate: SR });
    await run('empty', [new Float32Array(0)], 1.5, { sampleRate: SR });
    await run('very short', [noise(100, 4)], 2, { sampleRate: SR });
    await run('frame 20 ms, tolerance 6 ms', [bed], 1.2, { sampleRate: SR, frameMs: 20, toleranceMs: 6 });
    await run('frame 80 ms, tolerance 25 ms', [bed], 1.2, { sampleRate: SR, frameMs: 80, toleranceMs: 25 });
    for (const rate of [44100, 22050, 16000]) {
      await run(`clicks at ${rate}`, [clickBed(rate, 1.8, 0.31, 5)], 1.35, { sampleRate: rate });
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/wsola-stretch.txt');
  });

  it('hands the output over in the same pieces as it builds it', () => {
    const SR = 44100;
    const x = clickBed(SR, 1.5, 0.3, 9);
    const whole = timeStretch([x], 1.3, { sampleRate: SR })[0] as Float32Array;
    const pieces: [number, number][] = [];
    const joined = new Float32Array(whole.length);
    stretchStream([x], 1.3, { sampleRate: SR }, (at, chunk, n) => {
      pieces.push([at, n]);
      joined.set((chunk[0] as Float32Array).subarray(0, n), at);
    });
    expect(joined).toEqual(whole);
    expect(pieces.length).toBeGreaterThan(10);
    expect(pieces[0]?.[0]).toBe(0);
  });

  it('finds the same attacks', async () => {
    const lines: string[] = [];
    for (const [rate, every, seed] of [
      [48000, 0.37, 3],
      [44100, 0.5, 4],
      [16000, 0.25, 6],
    ] as const) {
      const onsets = detectOnsets(clickBed(rate, 3, every, seed), rate);
      lines.push(`${rate} Hz every ${every} s: ${onsets.map((o) => `${o.at}:${o.strength.toFixed(6)}`).join(' ')}`);
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/wsola-onsets.txt');
  });
});
