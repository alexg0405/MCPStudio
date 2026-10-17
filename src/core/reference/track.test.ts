import { describe, expect, it } from 'vitest';
import { fakeAnalysis } from '../dj/fake-analysis';
import { createEmptyProject } from '../model/defaults';
import { repairProject } from '../schema/migrate';
import type { Project } from '../model/types';
import { TONE_BANDS } from './bands';
import { fakeReference } from './fixtures';
import { buildReference, referenceFacts, sectionStrip, type ToneMeasure } from './track';

const tone = (sections: number): ToneMeasure => ({
  bands: [-13, -4, -5, -8, -13, -17, -23, -33],
  width: 0.4321,
  sections: Array.from({ length: sections }, (_, i) => ({ bands: TONE_BANDS.map((_b, j) => -10 - i - j), width: 0.2 })),
});

describe('building the reference from an analysis', () => {
  it('keeps only measurements, rounded, with the bars of the reference’s own grid', () => {
    const a = fakeAnalysis({ bpm: 128, key: { root: 9, mode: 'minor' }, bars: 96, lufs: -8.123 });
    const ref = buildReference(a, tone(3), { title: 'A song' });
    expect(ref.bpm).toBe(128);
    expect(ref.lufs).toBe(-8.1);
    expect(ref.key).toMatchObject({ root: 9, mode: 'minor', camelot: '8A' });
    expect(ref.sections.map((s) => [s.kind, s.bars])).toEqual([
      ['intro', 16],
      ['body', 64],
      ['outro', 16],
    ]);
    expect(ref.sections[1]!.bands[0]).toBe(-11);
    expect(ref.width).toBe(0.43);
    expect(ref.energy.length).toBe(96);
    expect(sectionStrip(ref)).toBe('Intro 16 · Main part 64 · Outro 16');
    // Nothing but numbers and short text: no audio or note data can be in it.
    expect(JSON.stringify(ref).length).toBeLessThan(8000);
    expect(referenceFacts(ref)).toContain('128 BPM');
  });

  it('a song with no grid or key says so, and a long song’s energy is averaged down', () => {
    const a = fakeAnalysis({ bpm: 120, noGrid: true, key: null, bars: 3000, energy: Array.from({ length: 3000 }, (_, i) => (i % 2 ? 1 : 0)) });
    const ref = buildReference(a, tone(3), { title: 'x'.repeat(500) });
    expect(ref.bpm).toBeNull();
    expect(ref.key).toBeNull();
    expect(ref.energy.length).toBe(1024);
    expect(ref.title.length).toBe(160);
    expect(referenceFacts(ref)[0]).toBe('no steady tempo found');
  });
});

describe('repairing a project’s reference', () => {
  const withReference = (ref: unknown): Project => ({ ...createEmptyProject(), reference: ref as never });

  it('leaves a good reference as it is (repairing twice changes nothing)', () => {
    const p = withReference(fakeReference());
    const once = repairProject(p);
    expect(once.repairs).toEqual([]);
    expect(once.project.reference).toEqual(p.reference);
    expect(repairProject(once.project).repairs).toEqual([]);
  });

  it('forgets a reference that is not one, and keeps the rest of the project', () => {
    for (const bad of [42, { title: 'x' }, { ...fakeReference(), bands: [1, 2, 3] }, { ...fakeReference(), sections: 'no' }]) {
      const r = repairProject(withReference(bad));
      expect(r.project.reference).toBeUndefined();
      expect(r.repairs.join(' ')).toMatch(/reference/);
    }
  });

  it('fixes what can be fixed: sections, values out of range, a sample that is gone', () => {
    const good = fakeReference();
    const damaged = {
      ...good,
      sampleId: 'smp_gone',
      bpm: 9999,
      key: { root: 40, mode: 'dorian' },
      energy: [0.5, 4, -1, 'x', 0.2],
      sections: [
        { ...good.sections[0]!, energy: 7, bands: [1] },
        { kind: 'weird', startSec: 0, endSec: 1, bars: 1, energy: 0, bands: good.bands, width: 0 },
        good.sections[1],
      ],
    };
    const r = repairProject(withReference(damaged));
    const ref = r.project.reference!;
    expect(r.repairs).toEqual(['Fixed damaged reference song details.']);
    expect(ref.sampleId).toBeUndefined();
    expect(ref.bpm).toBeNull();
    expect(ref.key).toBeNull();
    expect(ref.energy).toEqual([0.5, 1, 0, 0.2]);
    expect(ref.sections.map((s) => s.kind)).toEqual(['intro', 'drop']);
    expect(ref.sections[0]!.energy).toBe(0.5);
    expect(ref.sections[0]!.bands).toEqual(new Array(8).fill(-60));
    expect(repairProject(r.project).repairs).toEqual([]);
  });
});
