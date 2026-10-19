/**
 * Characterization of transient and tempo detection: the hit times found in seeded hit trains (soft and loud, close
 * and far apart, with different sensitivities, gaps and ranges) and the tempo read from loops (straight, syncopated,
 * whole bars or not), all exactly. It exists so transients.ts can be reorganised without changing a result.
 *
 * If a deliberate change makes it fail, review the snapshot diff and regenerate it with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../voice/test-signals';
import { detectTempo, detectTransients } from './transients';

/** Decaying noise bursts at `times` (seconds) with `levels`, over quiet noise. */
function hitTrain(times: number[], levels: number[], seconds: number, sampleRate: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const x = new Float32Array(Math.round(seconds * sampleRate)).map(() => 0.002 * (rand() - 0.5));
  times.forEach((t, k) => {
    const at = Math.round(t * sampleRate);
    for (let i = 0; i < 0.12 * sampleRate && at + i < x.length; i++) {
      x[at + i] = (x[at + i] as number) + (levels[k] ?? 0.8) * Math.exp(-i / (0.025 * sampleRate)) * (rand() * 2 - 1);
    }
  });
  return x;
}

describe('transient characterization', () => {
  it('finds the same hits', () => {
    const lines: string[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const rand = mulberry32(seed);
      const sampleRate = [48000, 44100, 22050][seed % 3] as number;
      const times: number[] = [];
      const levels: number[] = [];
      for (let t = 0.1; t < 3.4; t += 0.08 + rand() * 0.4) {
        times.push(t);
        levels.push(0.05 + rand() * 0.9);
      }
      const x = hitTrain(times, levels, 3.6, sampleRate, seed);
      for (const opts of [{}, { sensitivity: 0 }, { sensitivity: 1 }, { minGap: 0.2 }, { from: 0.5, to: 2.5 }]) {
        const found = detectTransients([x], sampleRate, opts);
        lines.push(`#${seed} ${JSON.stringify(opts)}: ${found.map((t) => t.toFixed(5)).join(' ')}`);
      }
      const stereo = detectTransients([x, x.map((v, i) => (i % 7 === 0 ? 0 : v * 0.6))], sampleRate);
      lines.push(`#${seed} stereo: ${stereo.map((t) => t.toFixed(5)).join(' ')}`);
    }
    expect(lines.join('\n') + '\n').toMatchSnapshot();
  });

  it('reads the same tempo', () => {
    const lines: string[] = [];
    const sampleRate = 44100;
    for (const bpm of [70, 88, 100, 120, 128, 140, 174]) {
      for (const [label, steps] of [
        ['straight', [0, 4, 8, 12]],
        ['four on the floor with hats', [0, 2, 4, 6, 8, 10, 12, 14]],
        ['syncopated', [0, 3, 6, 9, 12]],
        ['sparse', [0, 8]],
      ] as const) {
        for (const bars of [2, 3.5]) {
          const stepSec = 60 / bpm / 4;
          const seconds = bars * 16 * stepSec;
          const times: number[] = [];
          for (let bar = 0; bar < Math.ceil(bars); bar++) for (const s of steps) times.push((bar * 16 + s) * stepSec);
          const kept = times.filter((t) => t < seconds - 0.1);
          const x = hitTrain(
            kept,
            kept.map((_, i) => (i % 4 === 0 ? 0.9 : 0.5)),
            seconds,
            sampleRate,
            bpm,
          );
          lines.push(
            `${bpm} bpm ${label} ${bars} bars: ${detectTempo([x], sampleRate)} (3/4: ${detectTempo([x], sampleRate, { beatsPerBar: 3 })})`,
          );
        }
      }
    }
    lines.push(`short: ${detectTempo([new Float32Array(1000)], sampleRate)}`);
    lines.push(`silence: ${detectTempo([new Float32Array(3 * sampleRate)], sampleRate)}`);
    expect(lines.join('\n') + '\n').toMatchSnapshot();
  });
});
