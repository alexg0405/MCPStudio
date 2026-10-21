import { describe, expect, it } from 'vitest';
import { cpuNow, perfLimit, settle } from '../../../test/helpers/perf';
import { engrave } from './engrave';
import { renderSheet } from './render';
import { input, noteAt } from './test-input';

/** A dense pattern: a chord of three and a run of sixteenths in every beat for 100 bars (about 2800 notes), some of it off the grid. */
function densePattern() {
  const notes = [];
  for (let bar = 0; bar < 100; bar++) {
    for (let beat = 0; beat < 4; beat++) {
      const start = bar * 3840 + beat * 960;
      for (const key of [48, 52, 55]) notes.push(noteAt(start, 900, key));
      for (let i = 0; i < 4; i++) notes.push(noteAt(start + i * 240 + (i % 2) * 7, 220, 72 + i));
    }
  }
  return notes;
}

describe('engraving speed', () => {
  it('engraves and draws 100 dense bars in well under a few seconds', { tags: ['perf'] }, async () => {
    const notes = densePattern();
    const limitMs = perfLimit(600, 4000);
    const best = await settle(
      () => {
        const start = cpuNow();
        const score = engrave(input(notes, { lengthTicks: 3840 * 100 }));
        renderSheet(score, { width: 900, zoom: 1 });
        return cpuNow() - start;
      },
      (ms) => ms < limitMs,
    );
    expect(notes.length).toBeGreaterThan(2500);
    expect(best, `took ${Math.round(best)} ms`).toBeLessThan(limitMs);
  });
});
