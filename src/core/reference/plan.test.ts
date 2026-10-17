import { describe, expect, it } from 'vitest';
import { fakeReference } from './fixtures';
import { barsFor, energyLevel, MAX_BARS, MAX_SECTION_BARS, MAX_SECTIONS, planReferenceSections, planStrip, roleOf } from './plan';

const barSec = (bpm: number) => 240 / bpm;

describe('the reference’s sections as an arrangement request', () => {
  it('keeps 16 + 32 + 16 + 32 bars at the same tempo, with names, roles and energy 1–5', () => {
    const plan = planReferenceSections(fakeReference(), barSec(128));
    expect(plan.notes).toEqual([]);
    expect(plan.sections.map((s) => [s.name, s.role, s.bars, s.energy])).toEqual([
      ['Intro', 'intro', 16, 2],
      ['Drop', 'drop', 32, 5],
      ['Break', 'break', 16, 2],
      ['Drop 2', 'drop', 32, 5],
    ]);
    expect(planStrip(plan.sections)).toBe('Intro 16 · Drop 32 · Break 16 · Drop 2 32');
  });

  it('works in seconds: at half the tempo the same time is half the bars', () => {
    const plan = planReferenceSections(fakeReference(), barSec(64));
    expect(plan.sections.map((s) => s.bars)).toEqual([8, 16, 8, 16]);
    const faster = planReferenceSections(fakeReference(), barSec(256));
    expect(faster.sections.map((s) => s.bars)).toEqual([32, 64, 32, 64]);
  });

  it('rounds to whole bars and to phrases of 4 when within a bar', () => {
    expect(barsFor(3.4 * 1.875, 1.875)).toBe(3);
    expect(barsFor(15.2 * 1.875, 1.875)).toBe(16);
    expect(barsFor(13.4 * 1.875, 1.875)).toBe(13);
    expect(barsFor(0.2 * 1.875, 1.875)).toBe(1);
  });

  it('maps relative energy to 1–5 and keeps each part’s usual range', () => {
    expect([0, 0.12, 0.25, 0.5, 0.75, 1].map(energyLevel)).toEqual([1, 1, 2, 3, 4, 5]);
    expect(roleOf({ kind: 'intro', energy: 0.9 })).toEqual({ role: 'intro', energy: 2 });
    expect(roleOf({ kind: 'drop', energy: 0.3 })).toEqual({ role: 'drop', energy: 4 });
    expect(roleOf({ kind: 'break', energy: 0.9 }).energy).toBe(3);
    expect(roleOf({ kind: 'body', energy: 0.9 })).toEqual({ role: 'chorus', energy: 5 });
    expect(roleOf({ kind: 'body', energy: 0.5 }).role).toBe('verse');
  });

  it('joins parts under 2 bars to their neighbour', () => {
    const ref = fakeReference({
      sections: [
        { kind: 'intro', bars: 8, energy: 0.3 },
        { kind: 'build', bars: 1, energy: 0.6 },
        { kind: 'drop', bars: 16, energy: 1 },
      ],
    });
    const plan = planReferenceSections(ref, barSec(128));
    expect(plan.sections.map((s) => [s.role, s.bars])).toEqual([
      ['intro', 9],
      ['drop', 16],
    ]);
    expect(plan.notes[0]).toMatch(/too short/);
  });

  it('splits a part over 64 bars and cuts the end at 512 bars; more than 24 sections are joined', () => {
    const long = planReferenceSections(fakeReference({ sections: [{ kind: 'drop', bars: 150, energy: 1 }] }), barSec(128));
    expect(long.sections.map((s) => s.bars)).toEqual([50, 50, 50]);
    expect(long.sections.every((s) => s.bars <= MAX_SECTION_BARS)).toBe(true);
    const huge = planReferenceSections(fakeReference({ sections: Array.from({ length: 12 }, () => ({ kind: 'drop' as const, bars: 60, energy: 1 })) }), barSec(128));
    expect(huge.sections.reduce((n, s) => n + s.bars, 0)).toBeLessThanOrEqual(MAX_BARS);
    expect(huge.notes.join(' ')).toMatch(/left off/);
    const many = planReferenceSections(
      fakeReference({ sections: Array.from({ length: 40 }, (_, i) => ({ kind: i % 2 ? ('break' as const) : ('drop' as const), bars: 4 + (i % 3), energy: i % 2 ? 0.3 : 1 })) }),
      barSec(128),
    );
    expect(many.sections.length).toBeLessThanOrEqual(MAX_SECTIONS);
    expect(many.sections.reduce((n, s) => n + s.bars, 0)).toBe(Array.from({ length: 40 }, (_, i) => 4 + (i % 3)).reduce((a, b) => a + b, 0));
  });

  it('says so when the reference has no sections', () => {
    expect(planReferenceSections(fakeReference({ sections: [] }), 2).sections).toEqual([]);
  });
});
