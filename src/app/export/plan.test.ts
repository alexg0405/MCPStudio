import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { newId } from '@core/model/ids';
import type { PatternClip } from '@core/model/types';
import { addClips } from '@core/ops/playlist';
import { createTestServices } from '../testing';
import { planExport } from './plan';

const BAR = 3840;

describe('planExport', () => {
  const s = createTestServices();
  const base = s.doc.getState().project;
  const patternId = base.patternOrder[0] ?? null;
  const laneId = base.playlist.laneOrder[0];

  it('exports the current pattern in pattern bars', () => {
    expect(planExport(base, { currentPatternId: patternId, loop: null }, 'pattern')).toEqual({
      mode: 'pattern',
      patternId,
      fromTick: 0,
      bars: 1,
    });
  });

  it('exports a span of the song (a section, a clip’s bars) in song mode', () => {
    expect(planExport(base, { currentPatternId: patternId, loop: null }, { from: 4 * BAR, to: 8 * BAR })).toEqual({
      mode: 'song',
      patternId,
      fromTick: 4 * BAR,
      bars: 4,
    });
    expect(planExport(base, { currentPatternId: patternId, loop: null }, { from: 8 * BAR, to: 8 * BAR })).toHaveProperty('error');
  });

  it('refuses an empty song and a missing loop region', () => {
    expect(planExport(base, { currentPatternId: patternId, loop: null }, 'song')).toHaveProperty('error');
    expect(planExport(base, { currentPatternId: patternId, loop: null }, 'loop')).toHaveProperty('error');
    expect(planExport(base, { currentPatternId: null, loop: null }, 'pattern')).toHaveProperty('error');
  });

  it('exports the song up to its last whole bar', () => {
    const clip: PatternClip = {
      kind: 'pattern',
      id: newId.clip(),
      laneId: laneId!,
      start: 2 * BAR,
      length: BAR + 960,
      patternId: patternId!,
      offset: 0,
    };
    const song = produce(base, (d) => addClips(d, [clip]));
    expect(planExport(song, { currentPatternId: patternId, loop: null }, 'song')).toEqual({
      mode: 'song',
      patternId,
      fromTick: 0,
      bars: 4,
    });
  });

  it('exports a loop region from its start, in fractional bars', () => {
    const loop = { start: BAR, end: BAR + 1920 };
    expect(planExport(base, { currentPatternId: patternId, loop }, 'loop')).toEqual({
      mode: 'song',
      patternId,
      fromTick: BAR,
      bars: 0.5,
    });
  });
});
