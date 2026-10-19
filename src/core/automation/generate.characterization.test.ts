/**
 * Characterization of the tool-made curves: LFO points for every shape over a spread of periods, depths,
 * centres, phases, starts and lengths; thinned recordings; merged loop passes and spliced takes, all exactly.
 * It exists so the generators can be reorganised without changing a point.
 *
 * If a deliberate change makes it fail, review the snapshot diff and regenerate it with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import type { AutoPoint } from '../model/types';
import { mulberry32 } from '../voice/test-signals';
import { LFO_SHAPES, lfoPoints, mergePasses, spliceCurve, thinSamples, type Sample } from './generate';

const line = (points: readonly AutoPoint[]) =>
  points
    .map((p) => `${p.tick}:${p.value.toFixed(6)}${p.shape ? `:${p.shape}` : ''}${p.tension ? `:t${p.tension}` : ''}`)
    .join(' ');

describe('automation generators characterization', () => {
  it('makes the same LFO points', async () => {
    const lines: string[] = [];
    const rand = mulberry32(7);
    for (const shape of LFO_SHAPES) {
      for (const period of [240, 960, 1920, 3840, 1000.5]) {
        for (const phase of [0, 0.25, 0.6, -0.3, 1.4]) {
          for (const [from, length] of [
            [0, 3840],
            [480, 2000],
            [1234, 777],
            [0, 1],
          ] as const) {
            const depth = [1, 0.5, 0.2, 1.4][Math.floor(rand() * 4)] as number;
            const center = [0.5, 0.2, 0.9][Math.floor(rand() * 3)] as number;
            const seed = Math.floor(rand() * 1000);
            const points = lfoPoints(from, length, { shape, period, depth, center, phase, seed });
            lines.push(
              `${shape} p${period} ph${phase} [${from}+${length}] d${depth} c${center} s${seed}: ${line(points)}`,
            );
          }
        }
      }
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/automation-lfo.txt');
  });

  it('thins, merges and splices the same way', () => {
    const lines: string[] = [];
    const rand = mulberry32(9);
    for (let n = 0; n < 12; n++) {
      const samples: Sample[] = [];
      let value = 0.5;
      for (let i = 0; i < 20 + n * 15; i++) {
        value = Math.max(0, Math.min(1, value + (rand() - 0.5) * 0.2));
        samples.push({ tick: i * 24 + Math.floor(rand() * 5), value });
      }
      lines.push(`thin ${n} tol .005: ${line(thinSamples(samples))}`);
      lines.push(`thin ${n} tol .05: ${line(thinSamples(samples, 0.05))}`);
    }
    lines.push(`thin tiny: ${line(thinSamples([{ tick: 3, value: 1.4 }]))}`);
    const passes: Sample[][] = [
      [
        { tick: 0, value: 0.1 },
        { tick: 100, value: 0.5 },
        { tick: 200, value: 0.2 },
      ],
      [
        { tick: 150, value: 0.9 },
        { tick: 300, value: 0.8 },
      ],
      [],
      [
        { tick: 50, value: 0.3 },
        { tick: 120, value: 0.4 },
      ],
    ];
    lines.push(`merge: ${JSON.stringify(mergePasses(passes))}`);
    const curve: AutoPoint[] = [
      { tick: 0, value: 0.2 },
      { tick: 480, value: 0.8, shape: 'smooth' },
      { tick: 960, value: 0.4 },
      { tick: 1920, value: 0.6 },
    ];
    for (const take of [
      [
        { tick: 300, value: 0.5 },
        { tick: 600, value: 0.55 },
      ],
      [
        { tick: 0, value: 0.2 },
        { tick: 100, value: 0.9 },
      ],
      [
        { tick: 1800, value: 0.1 },
        { tick: 2400, value: 0.3 },
      ],
      [],
    ]) {
      lines.push(`splice: ${line(spliceCurve(curve, take))}`);
    }
    expect(lines.join('\n') + '\n').toMatchSnapshot();
  });
});
