import { describe, expect, it } from 'vitest';
import { songCheck } from '@core/query/arrangement';
import { project, stackedSong } from '../../../../test/helpers/focus';
import { applyAnswer } from '../apply';

describe('tidy on the stacked song', () => {
  it('fixes what the song check reports in one undo step, and a second tidy changes nothing', () => {
    const { s } = stackedSong();
    const before = project(s);
    expect(songCheck(before).map((i) => i.kind)).toEqual(expect.arrayContaining(['stacked', 'duplicateAutomation']));
    const steps = s.history.steps().done.length;
    const first = applyAnswer(s, { message: 'ok', actions: [{ op: 'tidy' }] }, { previousBeat: null });
    expect(first.warnings).toEqual([]);
    expect(s.history.steps().done).toHaveLength(steps + 1);
    const kinds = songCheck(project(s)).map((i) => i.kind);
    expect(kinds).not.toContain('stacked');
    expect(kinds).not.toContain('duplicateAutomation');
    const tidied = project(s);
    const second = applyAnswer(s, { message: 'ok', actions: [{ op: 'tidy' }] }, { previousBeat: null });
    expect(second.edited).toBe(false);
    expect(project(s)).toBe(tidied);
    s.history.undo();
    expect(project(s)).toEqual(before);
  });
});
