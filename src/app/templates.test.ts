import { describe, expect, it } from 'vitest';
import { repairProject } from '@core/schema/migrate';
import { createTestServices } from './testing';
import { newFromTemplate, templateProject, TEMPLATES } from './templates';

describe('project templates', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s: a beat at its tempo, laid out over 8 bars', (_id, t) => {
    const s = createTestServices();
    const { project, patternId } = templateProject(s, t);
    expect(project.transport.bpm).toBe(t.bpm);
    const pattern = project.patterns[patternId]!;
    expect(pattern.name).toBe(`${t.name} beat`);
    const notes = Object.values(pattern.notes).reduce((n, byChannel) => n + Object.keys(byChannel).length, 0);
    expect(notes).toBeGreaterThan(8);
    const clips = Object.values(project.playlist.clips);
    expect(clips.length).toBeGreaterThan(0);
    expect(Math.max(...clips.map((c) => c.start + c.length))).toBeGreaterThanOrEqual(8 * 3840);
    expect(Object.values(project.playlist.markers).map((m) => m.name)).toEqual([t.name]);
    // A valid project as saved files see it.
    expect(repairProject(project).repairs).toEqual([]);
  });

  it('opens as a new untitled project with nothing to save', async () => {
    const s = createTestServices();
    expect(await newFromTemplate(s, 'house')).toBe(true);
    expect(s.doc.getState().project.transport.bpm).toBe(124);
    expect(s.history.status()).toMatchObject({ canUndo: false, dirty: false });
    expect(s.files.store.getState().name).toBe('Untitled');
    expect(await newFromTemplate(s, 'polka')).toBe(false);
  });
});
