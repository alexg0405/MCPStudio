import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '@core/model/defaults';
import { cachedForProject } from './project-cache';

describe('cachedForProject', () => {
  it('works an answer out once per project version and starts again for a new version', () => {
    const first = createEmptyProject();
    const second = produce(first, (draft) => void (draft.transport.bpm = 99));
    let calls = 0;
    const ask = (project: typeof first) => cachedForProject(project, 'question', () => ++calls);
    expect(ask(first)).toBe(1);
    expect(ask(first)).toBe(1);
    expect(ask(second)).toBe(2);
    expect(cachedForProject(first, 'other question', () => 'x')).toBe('x');
    expect(calls).toBe(2);
  });
});
