import { describe, expect, it } from 'vitest';
import { PAD_COUNT, planKit } from './kit';
import type { SampleRow } from './query';
import { SAMPLE_ANALYSIS_VERSION, type SampleAnalysis, type SampleCategory } from './types';

let n = 0;
const shot = (name: string, category: SampleCategory | null, over: Partial<SampleAnalysis> = {}): SampleRow => ({
  id: `s${n++}`,
  name,
  folder: 'F',
  path: `${name}.wav`,
  analysis: { v: SAMPLE_ANALYSIS_VERSION, kind: 'one-shot', durationSec: 0.3, category, confidence: 0.9, loudnessDb: -12, peakDb: -1, brightness: 1000, vec: [], ...over },
  favorite: false,
  userTags: [],
  lastUsed: 0,
});
const at = (plan: ReturnType<typeof planKit>, pad: number) => plan.pads[pad - 1]?.name ?? null;

describe('make a kit', () => {
  it('puts the drums on the General MIDI pads: kick 1, snare 3, clap 4, closed hat 7, open hat 11, crash 14', () => {
    const plan = planKit([
      shot('hat', 'hat'),
      shot('crash', 'cymbal'),
      shot('snare', 'snare'),
      shot('kick', 'kick'),
      shot('open', 'open-hat'),
      shot('clap', 'clap'),
    ]);
    expect(plan.pads).toHaveLength(PAD_COUNT);
    expect([1, 3, 4, 7, 11, 14].map((p) => at(plan, p))).toEqual(['kick', 'snare', 'clap', 'hat', 'open', 'crash']);
    expect(plan.pads.filter(Boolean)).toHaveLength(6);
    expect(plan.skipped).toEqual([]);
  });

  it('uses the second pad of a category for the second sound, the most confident first', () => {
    const plan = planKit([shot('kick b', 'kick', { confidence: 0.6 }), shot('kick a', 'kick', { confidence: 0.95 }), shot('808', '808'), shot('snare 1', 'snare'), shot('snare 2', 'snare'), shot('hat 1', 'hat'), shot('hat 2', 'hat')]);
    expect(at(plan, 1)).toBe('kick a');
    expect(at(plan, 2)).toBe('kick b');
    expect(at(plan, 3)).toBe('snare 1');
    expect(at(plan, 5)).toBe('snare 2');
    expect(at(plan, 7)).toBe('hat 1');
    expect(at(plan, 9)).toBe('hat 2');
    // The 808 found pads 2 and 1 taken: it goes to the end of the kit, not onto the clap's pad.
    expect(at(plan, 16)).toBe('808');
    expect(at(plan, 4)).toBeNull();
  });

  it('sends an 808 to pad 2 when there is a kick on pad 1, and toms up the left side from low to high', () => {
    const plan = planKit([shot('kick', 'kick'), shot('808', '808'), shot('tom hi', 'tom', { midi: 62 }), shot('tom lo', 'tom', { midi: 50 }), shot('tom mid', 'tom', { midi: 55 })]);
    expect(at(plan, 2)).toBe('808');
    expect([6, 8, 10].map((p) => at(plan, p))).toEqual(['tom lo', 'tom mid', 'tom hi']);
  });

  it('fills free pads with what has no named pad, and unrecognised sounds last', () => {
    const plan = planKit([shot('weird', null), shot('fx', 'fx'), shot('kick', 'kick'), shot('vox', 'vocal')]);
    expect(at(plan, 1)).toBe('kick');
    expect(at(plan, 16)).toBe('fx');
    expect(at(plan, 15)).toBe('vox');
    expect(plan.pads.filter(Boolean)).toHaveLength(4);
    expect(plan.pads.some((p) => p?.name === 'weird')).toBe(true);
  });

  it('skips loops, long files and files not analyzed yet, and says why', () => {
    const loop = shot('loop', null, { kind: 'loop' });
    const long = shot('song', null, { kind: 'long' });
    const none: SampleRow = { ...shot('x', 'kick'), analysis: null };
    const plan = planKit([loop, long, none, shot('kick', 'kick')]);
    expect(plan.pads.filter(Boolean).map((p) => p!.name)).toEqual(['kick']);
    expect(plan.skipped.map((s) => [s.row.name, s.why])).toEqual([
      ['loop', 'a loop, not a one-shot'],
      ['song', 'too long for a pad'],
      ['x', 'not analyzed yet'],
    ]);
  });

  it('fits at most 16 and reports the rest', () => {
    const many = Array.from({ length: 20 }, (_, i) => shot(`perc ${i}`, 'perc'));
    const plan = planKit(many);
    expect(plan.pads.filter(Boolean)).toHaveLength(16);
    expect(plan.skipped).toHaveLength(4);
    expect(plan.skipped[0]!.why).toBe('all 16 pads are taken');
    // Every row is on a pad once or skipped once.
    const placed = plan.pads.filter(Boolean).map((p) => p!.id);
    expect(new Set(placed).size).toBe(16);
  });

  it('is the same every time for the same sounds', () => {
    const rows = [shot('b', 'perc'), shot('a', 'perc'), shot('c', 'kick', { confidence: 0.8 }), shot('d', 'kick', { confidence: 0.8 })];
    expect(planKit(rows).pads.map((p) => p?.name)).toEqual(planKit([...rows].reverse()).pads.map((p) => p?.name));
  });
});
