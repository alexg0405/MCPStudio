import { describe, expect, it, vi } from 'vitest';
import { createTestServices } from './testing';
import { UNTITLED, baseName } from './project-files';

function setup() {
  const s = createTestServices();
  const askUnsaved = vi.fn(async () => 'discard' as const);
  const defaultLayout = vi.fn();
  s.files.setUi({ askUnsaved, defaultLayout });
  return { s, askUnsaved, defaultLayout };
}

const asFile = (bytes: Uint8Array, name: string) => new File([bytes.slice().buffer], name);

describe('ProjectFiles', () => {
  it('derives display names from file names', () => {
    expect(baseName('Song.agproj')).toBe('Song');
    expect(baseName('Song.AGPROJ')).toBe('Song');
    expect(baseName('.agproj')).toBe(UNTITLED);
  });

  it('round-trips a project and its view through a project file', async () => {
    const { s } = setup();
    s.history.transact('Tempo', (d) => void (d.transport.bpm = 141));
    s.view.getState().setMode('song');
    s.view.getState().setLoop({ start: 960, end: 7680 });
    s.view.getState().showWindow('playlist', 'playlist');
    const saved = s.doc.getState().project;
    const bytes = await s.files.build();

    s.history.transact('Tempo', (d) => void (d.transport.bpm = 90));
    s.view.getState().setMode('pattern');
    s.view.getState().setLoop(null);
    expect(await s.files.openFile(asFile(bytes, 'My song.agproj'))).toBe(true);

    expect(s.doc.getState().project).toEqual(saved);
    expect(s.view.getState().mode).toBe('song');
    expect(s.view.getState().loop).toEqual({ start: 960, end: 7680 });
    expect(Object.keys(s.view.getState().windows)).toContain('playlist');
    expect(s.files.store.getState().name).toBe('My song');
    expect(s.history.status()).toMatchObject({ dirty: false, canUndo: false });
  });

  it('asks before replacing unsaved work and respects Cancel', async () => {
    const { s, askUnsaved } = setup();
    const bytes = await s.files.build();
    s.history.transact('Tempo', (d) => void (d.transport.bpm = 150));
    askUnsaved.mockResolvedValueOnce('cancel' as never);
    expect(await s.files.openFile(asFile(bytes, 'Other.agproj'))).toBe(false);
    expect(askUnsaved).toHaveBeenCalledWith(UNTITLED);
    expect(s.doc.getState().project.transport.bpm).toBe(150);
    expect(s.history.status().dirty).toBe(true);
  });

  it("doesn't ask when there is nothing unsaved", async () => {
    const { s, askUnsaved } = setup();
    expect(await s.files.newProject()).toBe(true);
    expect(askUnsaved).not.toHaveBeenCalled();
  });

  it('starts a new project with the default layout', async () => {
    const { s, defaultLayout } = setup();
    s.history.transact('Tempo', (d) => void (d.transport.bpm = 150));
    expect(await s.files.newProject()).toBe(true);
    expect(s.doc.getState().project.transport.bpm).toBe(130);
    expect(defaultLayout).toHaveBeenCalled();
    expect(s.files.store.getState()).toMatchObject({ name: UNTITLED, handle: null, fileKey: null });
    expect(s.history.status().dirty).toBe(false);
  });

  it('reports a file that is not a project and keeps the current one', async () => {
    const { s } = setup();
    s.history.transact('Tempo', (d) => void (d.transport.bpm = 150));
    s.history.markSaved();
    const ok = await s.files.openFile(asFile(new TextEncoder().encode('hello'), 'notes.agproj'));
    expect(ok).toBe(false);
    expect(s.doc.getState().project.transport.bpm).toBe(150);
    expect(s.session.getState().toasts.at(-1)).toMatchObject({ kind: 'error' });
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/not an AGstudio project/);
  });

  it('marks recovered work as unsaved', () => {
    const { s } = setup();
    const project = s.doc.getState().project;
    s.files.replace(project, null, { name: 'Recovered', handle: null, fileKey: null }, { dirty: true });
    expect(s.history.status().dirty).toBe(true);
    expect(s.files.store.getState().name).toBe('Recovered');
  });
});
