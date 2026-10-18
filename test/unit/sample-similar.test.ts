/**
 * "Similar sounds" on analyzed corpus sounds (the nearest to a kick should be kicks), and how fast the analysis is on short
 * one-shots (files per second, CPU time, the way the other speed tests measure).
 */
import { describe, expect, it } from 'vitest';
import { analyzeSample } from '@core/samples/analyze';
import { similarTo, type SampleRow } from '@core/samples/query';
import { engineCorpus, handmadeCorpus, SR } from '../helpers/sample-corpus';
import { cpuNow, perfLimit, settle } from '../helpers/perf';

describe('similar sounds', () => {
  const sounds = [...engineCorpus(), ...handmadeCorpus(12)].filter((s) => s.clear);
  const rows: SampleRow[] = sounds.map((s, i) => ({
    id: `s${i}`,
    name: s.name,
    folder: 'corpus',
    path: `${s.name}.wav`,
    analysis: analyzeSample([s.x], SR),
    favorite: false,
    userTags: [],
    lastUsed: 0,
  }));

  it('puts sounds of the same kind first: at least 85 % of the three nearest to a sound are of its own category', () => {
    let same = 0;
    let total = 0;
    const worst = new Map<string, number>();
    for (const r of rows) {
      const near = similarTo(rows, r, 3);
      for (const n of near) {
        total++;
        if (n.row.analysis?.category === r.analysis?.category) same++;
        else worst.set(`${r.analysis?.category}→${n.row.analysis?.category}`, (worst.get(`${r.analysis?.category}→${n.row.analysis?.category}`) ?? 0) + 1);
      }
    }
    expect(same / total, [...worst].map(([k, v]) => `${k} ×${v}`).join(', ')).toBeGreaterThanOrEqual(0.85);
  });

  it('finds the sibling in a set of lookalikes: a kick with a slightly shorter tail is nearer than a snare', () => {
    const kick = rows.find((r) => r.name === 'kit/kick')!;
    const near = similarTo(rows, kick, 5).map((n) => n.row.analysis?.category);
    expect(near.filter((c) => c === 'kick' || c === '808').length).toBeGreaterThanOrEqual(4);
  });

  it('keeps a loop away from one-shots', () => {
    const loop: SampleRow = { ...rows[0]!, id: 'loop', analysis: { ...rows[0]!.analysis!, kind: 'loop' } };
    expect(similarTo(rows, loop, 3)).toEqual([]);
  });
});

describe('analysis speed', () => {
  // The files of a sample folder are mostly one-shots under a second; 600 of them, as 44.1 kHz mono.
  const pool = [...engineCorpus(), ...handmadeCorpus(12)].map((s) => s.x).filter((x) => x.length / SR < 1.5);

  it('analyzes short one-shots at 100 files per second or better on one core (loose bound; strict 200)', { tags: ['perf'], timeout: 120_000 }, async () => {
    const n = 600;
    const rate = await settle(
      () => {
        const t0 = cpuNow();
        for (let i = 0; i < n; i++) analyzeSample([pool[i % pool.length]!], SR);
        return n / ((cpuNow() - t0) / 1000);
      },
      (r) => r >= perfLimit(200, 100),
      { better: 'higher' },
    );
    expect(rate).toBeGreaterThanOrEqual(perfLimit(200, 100));
  });
});
