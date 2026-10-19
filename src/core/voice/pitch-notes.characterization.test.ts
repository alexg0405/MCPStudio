/**
 * Characterization of the sung-pitch analysis: the cleaned track (octave slips, dropouts, short runs), the
 * notes cut from a track (levels, glides, vibrato, gaps), their statistics, and the whole pipeline on synthetic
 * voices. It exists so the analysis can be reorganised without changing a note it finds.
 *
 * If a deliberate change makes it fail, review the snapshot diff and regenerate it with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../io/hash';
import {
  analyzePitch,
  cleanF0,
  framesToCents,
  noteStats,
  segmentNotes,
  slowLine,
  type PitchFrames,
} from './pitch-notes';
import { mulberry32, noiseFloor, synthHum } from './test-signals';

/** Rounds every number so a different platform's last-bit differences cannot fail the snapshot. */
function rounded(value: unknown): unknown {
  if (typeof value === 'number') return Math.round(value * 1e4) / 1e4;
  if (Array.isArray(value)) return value.map(rounded);
  if (ArrayBuffer.isView(value))
    return Array.from(value as unknown as ArrayLike<number>).map((v) => Math.round(v * 1e3) / 1e3);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, rounded(inner)]));
  }
  return value;
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** A sung track at 5 ms frames: notes (MIDI, seconds) with vibrato, glides between them, gaps and occasional octave slips. */
function sungTrack(seed: number): PitchFrames {
  const rand = mulberry32(seed);
  const hop = 0.005;
  const f0: number[] = [];
  const conf: number[] = [];
  let midi = 55 + Math.floor(rand() * 10);
  for (let n = 0; n < 6; n++) {
    const next = midi + Math.round((rand() - 0.5) * 8);
    const frames = 20 + Math.floor(rand() * 90);
    const glide = Math.floor(rand() * 12);
    const vibrato = rand() < 0.5 ? 0.3 + rand() * 0.5 : 0;
    for (let i = 0; i < frames; i++) {
      const t = i * hop;
      const base = i < glide ? midi + ((next - midi) * i) / Math.max(1, glide) : next;
      const m = base + vibrato * Math.sin(2 * Math.PI * 5.5 * t) + (rand() - 0.5) * 0.08;
      let hz = midiToHz(m);
      if (rand() < 0.03) hz *= rand() < 0.5 ? 2 : 0.5;
      f0.push(hz);
      conf.push(0.8 + rand() * 0.2);
    }
    midi = next;
    const gap = rand() < 0.5 ? Math.floor(rand() * 10) : 0;
    for (let i = 0; i < gap; i++) {
      f0.push(0);
      conf.push(rand() * 0.3);
    }
  }
  return { t0: 0.1, hop, f0: Float32Array.from(f0), conf: Float32Array.from(conf) };
}

/** A short fingerprint of an array's exact values. */
async function hashOf(values: Float32Array | Float64Array): Promise<string> {
  const hash = await sha256Hex(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  return hash.slice(0, 12);
}

describe('pitch notes characterization', () => {
  it('cleans, segments and measures the same way', async () => {
    const lines: string[] = [];
    for (let seed = 1; seed <= 25; seed++) {
      const raw = sungTrack(seed);
      const cleaned = cleanF0(raw.f0, raw.conf);
      lines.push(`#${seed} clean: ${await hashOf(cleaned.f0)}`);
      lines.push(`#${seed} conf: ${await hashOf(cleaned.conf)}`);
      const notes = segmentNotes({ ...raw, f0: cleaned.f0, conf: cleaned.conf });
      lines.push(`#${seed} notes: ${JSON.stringify(rounded(notes))}`);
      const cents = framesToCents(cleaned.f0);
      lines.push(
        `#${seed} stats: ${JSON.stringify(rounded(noteStats(cleaned.f0, cents, 0, cleaned.f0.length - 1, raw.hop)))}`,
      );
      lines.push(`#${seed} slow: ${await hashOf(slowLine(cents, 3, Math.min(60, cents.length - 1), 34))}`);
    }
    expect(lines.join('\n') + '\n').toMatchSnapshot();
  });

  it('analyzes synthetic voices the same way', () => {
    const lines: string[] = [];
    for (const sr of [44100, 22050]) {
      const hums = [
        synthHum(sr, { hz: 196, durationSec: 0.9 }),
        synthHum(sr, { hz: 150, glideToHz: 300, durationSec: 0.9 }),
        synthHum(sr, {
          hz: 130,
          durationSec: 1.4,
          legato: [
            [165, 0.5],
            [110, 1],
          ],
        }),
      ];
      const noise = noiseFloor(sr, 1.6, -45, 3);
      for (let h = 0; h < hums.length; h++) {
        const x = Float32Array.from(noise);
        hums[h]!.forEach((v, i) => {
          x[i + Math.round(0.2 * sr)] = (x[i + Math.round(0.2 * sr)] as number) + v * 0.7;
        });
        for (const repairOctaves of [true, false]) {
          const analysis = analyzePitch(x, sr, { start: 0.5, repairOctaves });
          lines.push(
            `${sr} Hz hum ${h} repair ${repairOctaves}: ${JSON.stringify(rounded(analysis.notes))} hop ${analysis.hop}`,
          );
        }
      }
    }
    expect(lines.join('\n') + '\n').toMatchSnapshot();
  });
});
