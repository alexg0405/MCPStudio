import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '../model/defaults';
import { projectJson } from './project-json';

describe('projectJson', () => {
  it('is JSON.stringify of the project, made once per project object', () => {
    const project = createEmptyProject({ now: new Date(0) });
    expect(projectJson(project)).toBe(JSON.stringify(project));
    expect(projectJson(project)).toBe(projectJson(project));
  });

  it('gives a new text for a new version of the project', () => {
    const project = createEmptyProject({ now: new Date(0) });
    const edited = produce(project, (draft) => void (draft.transport.bpm = 99));
    expect(projectJson(edited)).not.toBe(projectJson(project));
    expect(JSON.parse(projectJson(edited)).transport.bpm).toBe(99);
  });
});
