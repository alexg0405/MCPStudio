/**
 * Characterization of the PSOLA pitch shifter: a hash of every output sample (exact float bits) and of
 * the pitch marks for a spread of voices, pitch tracks and shifts (up, down, ramped, stereo, with
 * unvoiced gaps, unchanged). The shifter is DSP that must stay bit-for-bit what it was while its code
 * is reorganised.
 *
 * If a deliberate change makes it fail, review the cause and regenerate the snapshot with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../io/hash';
import { mulberry32, noiseFloor, synthHum } from '../voice/test-signals';
import { pitchMarks, psolaShift, type PsolaTrack } from './psola';

async function hashOf(values: readonly (Float32Array | Float64Array)[]): Promise<string> {
  const parts = await Promise.all(values.map((v) => sha256Hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))));
  return parts.map((p) => p.slice(0, 12)).join(' ');
}

/** A track of constant pitch, with a shift per frame from a function of the frame's time (s). */
function trackOf(
  frames: number,
  hop: number,
  f0: (i: number) => number,
  cents: (seconds: number) => number,
  sampleRate: number,
): PsolaTrack {
  const f0s = new Float32Array(frames);
  const shift = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    f0s[i] = f0(i);
    shift[i] = cents((i * hop) / sampleRate);
  }
  return { f0: f0s, shift, hop, t0: 0 };
}

describe('PSOLA characterization', () => {
  it('shifts the same samples for every voice, track and shift', async () => {
    const sr = 44100;
    const hop = 441;
    const lines: string[] = [];
    const run = async (label: string, channels: Float32Array[], track: PsolaTrack, maxCents?: number) => {
      const out = psolaShift(channels, sr, track, { maxCents });
      lines.push(`${label}: ${await hashOf(out)}`);
    };
    const voice = synthHum(sr, { hz: 196, durationSec: 1.2 });
    const glide = synthHum(sr, { hz: 150, glideToHz: 260, durationSec: 1.2 });
    const frames = Math.ceil(voice.length / hop);
    const steady = (hz: number) => () => hz;
    await run(
      'up 300',
      [voice],
      trackOf(frames, hop, steady(196), () => 300, sr),
    );
    await run(
      'down 500',
      [voice],
      trackOf(frames, hop, steady(196), () => -500, sr),
    );
    await run(
      'octave down',
      [voice],
      trackOf(frames, hop, steady(196), () => -1200, sr),
    );
    await run(
      'octave up',
      [voice],
      trackOf(frames, hop, steady(196), () => 1200, sr),
    );
    await run(
      'ramp',
      [voice],
      trackOf(frames, hop, steady(196), (t) => 400 * Math.sin(t * 5), sr),
    );
    await run(
      'late part only',
      [voice],
      trackOf(frames, hop, steady(196), (t) => (t > 0.6 ? 250 : 0), sr),
    );
    await run(
      'clamped',
      [voice],
      trackOf(frames, hop, steady(196), () => 900, sr),
      200,
    );
    await run(
      'no shift',
      [voice],
      trackOf(frames, hop, steady(196), () => 0, sr),
    );
    await run(
      'glide voice',
      [glide],
      trackOf(
        frames,
        hop,
        (i) => 150 + (110 * i) / frames,
        () => 350,
        sr,
      ),
    );
    await run(
      'unvoiced gaps',
      [voice],
      trackOf(
        frames,
        hop,
        (i) => (i % 17 < 4 ? 0 : 196),
        () => 200,
        sr,
      ),
    );
    const right = voice.map((v, i) => v * 0.6 + 0.1 * Math.sin(i / 50));
    await run(
      'stereo',
      [voice, right],
      trackOf(frames, hop, steady(196), () => 150, sr),
    );
    const noisy = voice.slice();
    const noise = noiseFloor(sr, 1.2, -30, 4);
    for (let i = 0; i < noisy.length; i++) noisy[i] = (noisy[i] as number) * 0.5 + (noise[i] as number);
    await run(
      'noisy',
      [noisy],
      trackOf(frames, hop, steady(196), () => -300, sr),
    );
    await run(
      'no pitch',
      [voice],
      trackOf(
        frames,
        hop,
        () => 0,
        () => 300,
        sr,
      ),
    );
    await run(
      'empty',
      [new Float32Array(0)],
      trackOf(0, hop, steady(196), () => 300, sr),
    );
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/psola-shift.txt');
  });

  it('puts the same pitch marks', async () => {
    const sr = 48000;
    const hop = 480;
    const rand = mulberry32(3);
    const lines: string[] = [];
    for (const hz of [110, 196, 330]) {
      const voice = synthHum(sr, { hz, durationSec: 0.8 });
      const frames = Math.ceil(voice.length / hop);
      const track = trackOf(
        frames,
        hop,
        (i) => (i % 23 < 3 ? 0 : hz * (1 + 0.02 * (rand() - 0.5))),
        () => 0,
        sr,
      );
      const marks = pitchMarks(voice, sr, track);
      const part = pitchMarks(voice, sr, track, 4000, 20000);
      lines.push(
        `${hz} Hz: ${marks.length} marks ${await hashOf([marks])}; part ${part.length} ${await hashOf([part])}`,
      );
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/psola-marks.txt');
  });
});
