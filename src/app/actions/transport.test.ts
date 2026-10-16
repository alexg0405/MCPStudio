import { describe, expect, it } from 'vitest';
import { createTestServices } from '../testing';
import type { PatternId } from '@core/model/types';
import { addPattern } from '@core/ops/playlist';
import { makePattern } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { barsToRange, findPattern, isPatternPlaying, playFrom, playPattern, playRange } from './transport';

function setup() {
  const s = createTestServices();
  const second = newId.pattern();
  s.history.transact('second pattern', (d) => addPattern(d, makePattern('Chorus', '#f00', second), 1));
  const first = s.doc.getState().project.patternOrder[0] as PatternId;
  return { s, first, second };
}

describe('play-this actions', () => {
  it('playPattern makes the pattern current, switches to pattern mode and plays from its start', () => {
    const { s, first, second } = setup();
    s.view.getState().setMode('song');
    s.view.getState().setCurrentPattern(first);
    expect(playPattern(s, second)).toBe(true);
    expect(s.view.getState().currentPatternId).toBe(second);
    expect(s.view.getState().mode).toBe('pattern');
    expect(s.fakeEngine.playing).toBe(true);
    expect(s.fakeEngine.lastPlayFrom).toBe(0);
    expect(isPatternPlaying(s, second)).toBe(true);
    expect(isPatternPlaying(s, first)).toBe(false);
    s.engine.stop();
    expect(isPatternPlaying(s, second)).toBe(false);
  });

  it('playPattern refuses a pattern that does not exist, and plays nothing', () => {
    const { s } = setup();
    expect(playPattern(s, 'pat_nope' as PatternId)).toBe(false);
    expect(s.fakeEngine.playing).toBe(false);
  });

  it('finds a pattern by id, name or number', () => {
    const { s, first, second } = setup();
    expect(findPattern(s, second)).toBe(second);
    expect(findPattern(s, 'chorus')).toBe(second);
    expect(findPattern(s, 1)).toBe(first);
    expect(findPattern(s, 2)).toBe(second);
    expect(findPattern(s, 'nothing')).toBeUndefined();
    expect(findPattern(s, 9)).toBeUndefined();
  });

  it('playRange loops the span in song mode and plays from its start', () => {
    const { s } = setup();
    expect(playRange(s, 7680, 15360)).toBe(true);
    expect(s.view.getState().loop).toEqual({ start: 7680, end: 15360 });
    expect(s.view.getState().mode).toBe('song');
    expect(s.fakeEngine.lastPlayFrom).toBe(7680);
    expect(s.view.getState().songStart).toBe(7680);
  });

  it('playRange ignores an empty or backwards span', () => {
    const { s } = setup();
    expect(playRange(s, 100, 100)).toBe(false);
    expect(playRange(s, 500, 100)).toBe(false);
    expect(s.fakeEngine.playing).toBe(false);
    expect(s.view.getState().loop).toBeNull();
  });

  it('playFrom plays the song from a tick, keeping a loop that contains it and clearing one that does not', () => {
    const { s } = setup();
    s.view.getState().setLoop({ start: 3840, end: 7680 });
    playFrom(s, 5000);
    expect(s.view.getState().loop).toEqual({ start: 3840, end: 7680 });
    expect(s.fakeEngine.lastPlayFrom).toBe(5000);
    playFrom(s, 20000);
    expect(s.view.getState().loop).toBeNull();
    expect(s.fakeEngine.lastPlayFrom).toBe(20000);
    expect(s.view.getState().mode).toBe('song');
  });

  it('turns bars into a tick range, both bars included', () => {
    const { s } = setup();
    expect(barsToRange(s, 5, 8)).toEqual({ from: 4 * 3840, to: 8 * 3840 });
    expect(barsToRange(s, 3, 1)).toEqual({ from: 2 * 3840, to: 3 * 3840 });
  });
});
