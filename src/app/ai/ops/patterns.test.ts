import { describe, expect, it } from 'vitest';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import type { AiAction } from '../schema';

const run = (s: ReturnType<typeof createTestServices>, actions: AiAction[]) =>
  applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });

describe('pattern actions', () => {
  it('keeps a huge length inside the editors limit (512 steps)', () => {
    const s = createTestServices();
    const find = () => Object.values(s.doc.getState().project.patterns).find((p) => p.name === 'Long')!;
    run(s, [{ op: 'add_pattern', ref: '@long', name: 'Long', bars: 1_000_000 }]);
    expect(find().stepCount).toBe(512);
    expect(find().length).toBe(32 * 3840);
    run(s, [{ op: 'edit_pattern', pattern: 'Long', bars: 99999 }]);
    expect(find().stepCount).toBe(512);
    run(s, [{ op: 'edit_pattern', pattern: 'Long', bars: 0.01 }]);
    expect(find().stepCount).toBe(1);
  });
});
