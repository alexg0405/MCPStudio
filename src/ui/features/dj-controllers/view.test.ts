import { describe, expect, it } from 'vitest';
import { targetInfo } from '@core/midi-map/targets';
import { chipText, groupedTargets, rowLabel } from './view';

describe('Controllers window view helpers', () => {
  it('groups a deck’s controls the way the list shows them, in order', () => {
    const groups = groupedTargets('A');
    expect(groups.map((g) => g.group)).toEqual(['Transport', 'Platter', 'Pitch', 'Mixer', 'Loops', 'Hot cues']);
    expect(groups[0]!.targets[0]!.id).toBe('A.play');
    expect(groups.flatMap((g) => g.targets).every((t) => t.deck === 'A')).toBe(true);
  });
  it('the global section has the crossfader and the library controls', () => {
    const ids = groupedTargets('global').flatMap((g) => g.targets.map((t) => t.id));
    expect(ids).toEqual(expect.arrayContaining(['crossfader', 'masterVolume', 'browse', 'record']));
  });
  it('names rows without repeating the deck, and describes links in plain words', () => {
    expect(rowLabel(targetInfo('B.eq.low')!)).toBe('EQ low');
    expect(rowLabel(targetInfo('crossfader')!)).toBe('Crossfader');
    expect(chipText({ input: { type: 'note', channel: 0, note: 11 }, target: 'A.play' })).toBe('Ch 1 note 11');
    expect(chipText({ input: { type: 'cc14', channel: 1, cc: 0 }, target: 'B.pitch', invert: true })).toBe('Ch 2 CC 0+32 (14-bit) (reversed)');
    expect(chipText({ input: { type: 'note', channel: 0, note: 5 }, target: 'A.sync', layer: 'shift' })).toBe('Shift + Ch 1 note 5');
    expect(chipText({ input: { type: 'rel', channel: 0, cc: 6, encoding: 'twos' }, target: 'A.jog', scale: 2 })).toContain('×2');
  });
});
