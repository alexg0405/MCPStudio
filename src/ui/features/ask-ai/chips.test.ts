import { describe, expect, it } from 'vitest';
import type { AiFocus } from '@app/ai/focus';
import { chipHint, NOTE_CHIPS, quickChips, TIME_CHIPS } from './chips';

const p = 'prj_x';

describe('quick requests for a part', () => {
  it('fits the kind of part: bars, clips and sections get the arrangement ones, notes the playing ones', () => {
    const range: AiFocus = { kind: 'range', from: 0, to: 3840, projectId: p };
    const section: AiFocus = { kind: 'section', markerId: 'mk_a' as never, from: 0, to: 3840, projectId: p };
    const clips: AiFocus = { kind: 'clips', clipIds: ['clip_a' as never], projectId: p };
    const notes: AiFocus = { kind: 'notes', patternId: 'pat_a' as never, channelId: 'ch_a' as never, noteIds: ['n_a' as never], projectId: p };
    for (const f of [range, section, clips]) expect(quickChips(f)).toBe(TIME_CHIPS);
    expect(quickChips(notes)).toBe(NOTE_CHIPS);
    expect(quickChips(null)).toEqual([]);
    expect(TIME_CHIPS).toEqual([
      'Smooth the transition in',
      'Smooth the transition out',
      'Add a fill at the end',
      'More variation',
      'Hit harder',
      'Strip it back',
    ]);
    expect(NOTE_CHIPS).toEqual(['Tighten the timing', 'More groove', 'Make it catchier']);
  });

  it('says what a chip asks and what changes', () => {
    expect(chipHint('Hit harder', 'Verse · bars 17–32')).toBe('Ask the AI: “Hit harder” (only Verse · bars 17–32 changes)');
    expect(chipHint('More groove', null)).toBe('Ask the AI: “More groove”');
  });
});
