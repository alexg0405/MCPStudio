import { describe, expect, it } from 'vitest';
import { stackedSong, project, BAR } from '../../../../test/helpers/focus';
import { applyAnswer } from '../apply';
import { focusFromRange } from '../focus-capture';
import { resolveFocus } from '../focus';

describe('arrange while working on a part', () => {
  it('leaves the patterns that also play elsewhere as they are (their first-beat crash stays)', () => {
    const { s, ids } = stackedSong();
    const before = project(s);
    const drop = ids.patterns.Drop!;
    const focus = resolveFocus(before, focusFromRange(s, 16 * BAR, 32 * BAR));
    const res = applyAnswer(
      s,
      {
        message: 'ok',
        actions: [
          {
            op: 'arrange',
            from_bar: 17,
            mix: 'keep',
            sections: [
              { name: 'Part A', role: 'drop', bars: 8, energy: 5, play: ['Drop'] },
              { name: 'Part B', role: 'drop', bars: 8, energy: 5, play: ['Drop'] },
            ],
          },
        ],
      },
      { previousBeat: null, focus },
    );
    expect(res.warnings).toEqual([]);
    // “Drop” also plays at bars 37–52 and 89–100: its notes are exactly as they were.
    expect(project(s).patterns[drop]!.notes).toEqual(before.patterns[drop]!.notes);
    s.history.undo();
    expect(project(s)).toEqual(before);
  });
});
