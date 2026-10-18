import { describe, expect, it } from 'vitest';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { STUDIO_PROMPT } from '../prompt';
import { readTools } from '../read';
import type { AiAction } from '../schema';
import { OPEN_WINDOWS } from './windows';

const BAR = 3840;
const run = (s: ReturnType<typeof createTestServices>, actions: AiAction[]) =>
  applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });

describe('loudness_report action', () => {
  it('changes nothing in the project and asks for the report after the edit (the whole song, or bars of it)', () => {
    const s = createTestServices();
    const before = s.doc.getState().project;
    const whole = run(s, [{ op: 'loudness_report' }]);
    expect(whole.after).toEqual([{ kind: 'loudness_report' }]);
    const part = run(s, [{ op: 'loudness_report', from_bar: 5, to_bar: 8 }]);
    expect(part.after).toEqual([{ kind: 'loudness_report', fromTick: 4 * BAR, toTick: 8 * BAR }]);
    expect(s.doc.getState().project).toBe(before);
    expect(whole.edited).toBe(false);
  });

  it('is in the prompt, the read tools and the windows Studio can open', () => {
    expect(STUDIO_PROMPT).toContain('loudness_report');
    expect(readTools.map((t) => t.name)).toContain('get_loudness');
    expect(OPEN_WINDOWS).toContain('meters');
  });
});
