import { describe, expect, it } from 'vitest';
import { channelRoles } from '@core/arrange/roles';
import { repairProject } from '@core/schema/migrate';
import { checkArrangement } from './arrange/check';
import { createTestServices } from './testing';
import { newFromTemplate, templateProject, TEMPLATES } from './templates';

/** Bugs that don't depend on how loud each section is guessed to be (the arranger checks the rest against its plan). */
const STRUCTURAL = new Set(['stacked', 'layered-fill', 'static-loop', 'silent', 'crash-spam']);

describe('project templates', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s: a beat at its tempo, arranged as an intro and a main part that flow', (_id, t) => {
    const s = createTestServices();
    const { project, patternId } = templateProject(s, t);
    expect(project.transport.bpm).toBe(t.bpm);
    const pattern = project.patterns[patternId]!;
    expect(pattern.name).toBe(`${t.name} beat`);
    const notes = Object.values(pattern.notes).reduce((n, byChannel) => n + Object.keys(byChannel).length, 0);
    expect(notes).toBeGreaterThan(8);
    const clips = Object.values(project.playlist.clips);
    expect(clips.length).toBeGreaterThan(0);
    expect(Math.max(...clips.map((c) => c.start + c.length))).toBeGreaterThanOrEqual(12 * 3840);
    expect(Object.values(project.playlist.markers).map((m) => m.name).sort()).toEqual(['Intro', t.name].sort());
    // The minimum: no arrangement bugs (stacked parts, layered fills, missing gaps…).
    expect(checkArrangement(s, project).filter((f) => f.severity === 'bug' && STRUCTURAL.has(f.code))).toEqual([]);
    // A valid project as saved files see it.
    expect(repairProject(project).repairs).toEqual([]);
  });

  it('delivers what each one promises', () => {
    const s = createTestServices();
    const notesOf = (p: ReturnType<typeof templateProject>['project'], pid: string, roles: string[]) => {
      const r = channelRoles(p);
      return Object.entries(p.patterns[pid as never]!.notes).flatMap(([cid, ns]) => (roles.includes(r.get(cid as never) ?? '') ? Object.values(ns) : []));
    };
    for (const id of ['trap', 'drill']) {
      const { project, patternId } = templateProject(s, TEMPLATES.find((t) => t.id === id)!);
      const bass = notesOf(project, patternId, ['808']).sort((a, b) => a.tick - b.tick);
      // A sliding 808: a note that starts before the previous one ends, on another key.
      expect(bass.some((n, i) => i > 0 && n.tick < bass[i - 1]!.tick + bass[i - 1]!.length && n.key !== bass[i - 1]!.key), id).toBe(true);
    }
    const boombap = templateProject(s, TEMPLATES.find((t) => t.id === 'boom-bap')!);
    expect(notesOf(boombap.project, boombap.patternId, ['bass', '808']).length).toBeGreaterThan(0);
    const lofi = templateProject(s, TEMPLATES.find((t) => t.id === 'lofi')!);
    const keys = notesOf(lofi.project, lofi.patternId, ['keys', 'chords', 'pad']);
    expect(keys.some((n) => keys.filter((m) => m.tick === n.tick).length >= 3)).toBe(true);
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
