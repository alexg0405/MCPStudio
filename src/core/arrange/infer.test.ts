import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { buildStackedSong } from '../fixtures/stacked-song';
import { createEmptyProject } from '../model/defaults';
import type { ClipId, PatternId } from '../model/types';
import { tidySong } from '../ops/tidy';
import { BAR, HINT, kitProject, trapGroove } from '../../../test/helpers/arrange';
import { estimateEnergy, existingFx, fillLikeClips, fxKindFromName, inferSections, layeredFills } from './infer';
import { variantEnv } from './variants';

function stacked() {
  let ids!: ReturnType<typeof buildStackedSong>;
  const p = produce(createEmptyProject(), (d) => {
    ids = buildStackedSong(d);
    tidySong(d);
  });
  return { p, ids, env: variantEnv(p, { style: 'trap', hint: HINT }) };
}

describe('reading a song', () => {
  it('finds the sections of the stacked song from its markers, with their energy', () => {
    const { p, env } = stacked();
    const sections = inferSections(p, env);
    expect(sections.map((s) => [s.name, s.from / BAR + 1, s.bars, s.role])).toEqual([
      ['Intro', 1, 8, 'intro'],
      ['Pre-verse', 9, 8, 'pre'],
      ['Verse', 17, 16, 'verse'],
      ['Build', 33, 4, 'build'],
      ['Drop', 37, 16, 'drop'],
      ['Bridge', 53, 12, 'bridge'],
      ['Build 2', 65, 4, 'build'],
      ['Drop 2', 69, 16, 'drop'],
      ['Breather', 85, 4, 'break'],
      ['Final Drop', 89, 12, 'drop'],
      ['Outro', 101, 12, 'outro'],
    ]);
    const e = Object.fromEntries(sections.map((s) => [s.name, s.energy]));
    expect(e.Intro).toBeLessThanOrEqual(2);
    expect(e.Drop).toBe(5);
    expect(e['Drop 2']).toBe(5);
    expect(e.Build).toBeLessThan(e.Drop!);
    expect(e.Breather).toBeLessThanOrEqual(2);
    expect(sections.find((s) => s.name === 'Drop')!.caps).toMatchObject({ drums: true, hats: true, slide: true });
    expect(sections.find((s) => s.name === 'Intro')!.caps.drums).toBe(false);
    expect(sections.find((s) => s.name === 'Drop')!.loopBars).toBe(2);
    // Within a range: only its sections, cut at its edges.
    expect(inferSections(p, env, { from: 36 * BAR, to: 60 * BAR }).map((s) => [s.name, s.bars])).toEqual([
      ['Drop', 16],
      ['Bridge', 8],
    ]);
  });

  it('without markers, sections start where what plays changes', () => {
    const { project, patterns } = kitProject((k) => ({ Beat: { notes: trapGroove(k) }, Other: { notes: trapGroove(k) } }));
    const lane = project.playlist.laneOrder[0]!;
    const p = produce(project, (d) => {
      const add = (id: string, start: number, pid: PatternId) =>
        (d.playlist.clips[id as ClipId] = { kind: 'pattern', id: id as ClipId, laneId: lane, start: start * BAR, length: 2 * BAR, patternId: pid, offset: 0 });
      for (let b = 0; b < 8; b += 2) add(`a${b}`, b, patterns.Beat!);
      for (let b = 8; b < 12; b += 2) add(`b${b}`, b, patterns.Other!);
    });
    const env = variantEnv(p, { style: 'trap', hint: HINT });
    expect(inferSections(p, env).map((s) => [s.name, s.from / BAR, s.bars])).toEqual([
      ['Part 1', 0, 8],
      ['Part 2', 8, 4],
    ]);
    expect(estimateEnergy(p, 0, 8 * BAR, env)).toBeGreaterThanOrEqual(4);
  });

  it('spots the tom fill played on top of the beat and the FX already there', () => {
    const { p, ids, env } = stacked();
    const fills = fillLikeClips(p, env);
    expect(fills.map((f) => f.from / BAR + 1)).toEqual([16.5, 32.5, 48.5, 64.5, 80.5, 96.5]);
    expect(fills.every((f) => f.patternId === ids.patterns['Tom fill'])).toBe(true);
    const layered = layeredFills(p, env);
    expect(layered.map((l) => l.fill.from / BAR + 1)).toEqual([16.5, 32.5, 48.5, 64.5, 80.5, 96.5]);
    expect(layered[1]!.under.length).toBeGreaterThan(0);
    const fx = existingFx(p, env);
    const at = (kind: string) => fx.filter((x) => x.kind === kind).map((x) => x.at / BAR + 1);
    expect(at('riser')).toEqual(expect.arrayContaining([17, 37, 69, 89]));
    expect(at('impact')).toEqual(expect.arrayContaining([17, 37, 69, 89]));
    expect(at('sub-drop')).toEqual(expect.arrayContaining([17, 37, 69, 89]));
    expect(at('crash')).toEqual(expect.arrayContaining([17, 19, 37]));
    expect(at('downlifter')).toEqual(expect.arrayContaining([53, 85, 101]));
  });

  it('reads FX from names', () => {
    expect(['Riser', 'Rev Crash', 'Reverse cymbal', 'Impact 2', 'Sub Drop', 'Downlifter', 'Whoosh', 'Pad'].map(fxKindFromName)).toEqual([
      'riser',
      'reverse-crash',
      'reverse-crash',
      'impact',
      'sub-drop',
      'downlifter',
      'whoosh',
      undefined,
    ]);
  });
});
