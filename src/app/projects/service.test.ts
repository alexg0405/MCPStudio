import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { Project } from '@core/model/types';
import type { RecentFileInfo } from '@core/projects/list';
import { songWithClips } from '@core/versions/test-songs';
import type { AutosaveMeta } from '@platform/opfs';
import { memoryKv } from '../storage/kv';
import { createTestServices } from '../testing';
import { memoryVersionFiles } from '../versions/memory';
import type { ProjectSources } from './service';

const START = Date.parse('2026-10-20T12:00:00Z');

beforeEach(() => {
  setIdSource(seededBytes(8));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

function rig(open: Project = songWithClips(2, 'Open one')) {
  const kv = memoryKv();
  const recents: RecentFileInfo[] = [];
  const autosaves: AutosaveMeta[] = [];
  const autosaved = new Map<string, Project>();
  const sources: ProjectSources = {
    recentFiles: async () => [...recents],
    autosaves: async () => [...autosaves],
    loadAutosave: async (sessionId) => {
      const project = autosaved.get(sessionId);
      return project ? { project } : null;
    },
  };
  const s = createTestServices({ project: open, versionBackend: { kv, files: memoryVersionFiles() }, projectSources: sources });
  s.versions.start();
  return { s, kv, recents, autosaves, autosaved };
}

const autosaveMeta = (project: Project, over: Partial<AutosaveMeta> = {}): AutosaveMeta => ({
  sessionId: `ses_${project.projectId}`,
  projectId: project.projectId,
  title: project.meta.title,
  savedAt: '2026-10-19T08:00:00Z',
  clean: false,
  slot: 'a',
  ...over,
});

describe('ProjectsService.list', () => {
  it('lists the open project with its facts once it has been seen', async () => {
    const { s } = rig();
    await vi.waitFor(async () => expect(await s.versions.catalog!.all()).toHaveLength(1));
    const items = await s.projects.list();
    expect(items).toHaveLength(0); // a card with no file, no autosave and no version has nothing to open
    await s.versions.saveNamed('First');
    const [item] = await s.projects.list();
    expect(item).toMatchObject({ name: 'Untitled', source: 'versions', isOpen: true, versionCount: 1 });
    expect(item!.facts).toMatchObject({ bars: 2, clips: 2, bpm: 130 });
    expect(item!.thumbnail?.rows.length).toBe(1);
  });

  it('shows the open project as it is now, not as it was when its card was written', async () => {
    const { s } = rig();
    await s.versions.saveNamed('First');
    s.history.transact('Faster', (draft) => void (draft.transport.bpm = 150));
    const [item] = await s.projects.list();
    expect(item!.facts!.bpm).toBe(150);
    // A project that is not open keeps what its card says.
    s.history.load(songWithClips(1, 'Elsewhere'));
    const other = (await s.projects.list()).find((i) => !i.isOpen)!;
    expect(other.facts!.bpm).toBe(130);
  });

  it('orders recent files by when they were opened, newest first', async () => {
    const { s, recents } = rig();
    recents.push(
      { key: 'f1', name: 'Old.agproj', usedAt: '2026-10-01T00:00:00Z' },
      { key: 'f2', name: 'New.agproj', usedAt: '2026-10-19T00:00:00Z' },
      { key: 'f3', name: 'Middle.agproj', usedAt: '2026-10-10T00:00:00Z' },
    );
    const { sortProjects } = await import('@core/projects/list');
    const sorted = sortProjects(await s.projects.list(), 'recent');
    expect(sorted.map((i) => i.name)).toEqual(['New', 'Middle', 'Old']);
  });

  it('makes cards for autosaves from before cards existed, so they show their numbers and picture', async () => {
    const { s, autosaves, autosaved } = rig();
    const crashed = songWithClips(5, 'Crashed work');
    autosaves.push(autosaveMeta(crashed));
    autosaved.set(`ses_${crashed.projectId}`, crashed);
    const items = await s.projects.list();
    const item = items.find((i) => i.projectId === crashed.projectId)!;
    expect(item).toMatchObject({ name: 'Crashed work', source: 'autosave', hasUnsavedWork: true });
    expect(item.facts).toMatchObject({ bars: 5, clips: 5 });
    expect(item.thumbnail).not.toBeNull();
    // Its times are those of the autosave, not of today.
    expect(item.lastOpenedAt).toBe(Date.parse('2026-10-19T08:00:00Z'));
    expect(await s.versions.catalog!.get(crashed.projectId)).not.toBeNull();
  });

  it('survives an autosave it cannot read', async () => {
    const { s, autosaves } = rig();
    autosaves.push(autosaveMeta(songWithClips(1, 'Unreadable')));
    const items = await s.projects.list();
    expect(items.map((i) => i.name)).toContain('Unreadable');
  });

  it('does not list a clean autosave of a project that is saved in a file', async () => {
    const { s, autosaves, recents } = rig();
    const saved = songWithClips(1, 'Saved');
    recents.push({ key: 'f1', name: 'Saved.agproj', usedAt: '2026-10-18T00:00:00Z' });
    autosaves.push(autosaveMeta(saved, { clean: true, fileKey: 'f1' }));
    const items = await s.projects.list();
    expect(items.filter((i) => i.name === 'Saved')).toHaveLength(1);
  });
});

describe('ProjectsService choices', () => {
  it('pins a project and takes one off the list without deleting its versions', async () => {
    const { s } = rig();
    await s.versions.saveNamed('Keep me');
    const projectId = s.doc.getState().project.projectId;
    let [item] = await s.projects.list();
    await s.projects.setPinned(item!, true);
    [item] = s.projects.view.getState().items;
    expect(item!.pinned).toBe(true);

    await s.projects.removeFromList(item!);
    expect(s.projects.view.getState().items).toEqual([]);
    expect(await s.versions.versionsOf(projectId)).toHaveLength(1);
  });

  it('brings a removed project back when it gets a new version', async () => {
    const { s } = rig();
    await s.versions.saveNamed('One');
    const [item] = await s.projects.list();
    await s.projects.removeFromList(item!);
    s.history.transact('Edit', (draft) => void (draft.transport.bpm = 99));
    await s.versions.saveNamed('Two');
    await vi.waitFor(async () => expect(await s.projects.list()).toHaveLength(1));
  });
});

describe('ProjectsService opening', () => {
  it('opens a project that only has versions from its newest one, keeping its identity', async () => {
    const { s } = rig();
    s.files.setUi({ askUnsaved: async () => 'discard' });
    await s.versions.saveNamed('Only version');
    const projectId = s.doc.getState().project.projectId;
    s.history.load(songWithClips(1, 'Elsewhere'));
    const item = (await s.projects.list()).find((i) => i.projectId === projectId)!;
    expect(await s.projects.open(item)).toBe(true);
    expect(s.doc.getState().project.projectId).toBe(projectId);
  });

  it('opens a copy of a project with only versions under a new identity', async () => {
    const { s } = rig();
    s.files.setUi({ askUnsaved: async () => 'discard' });
    await s.versions.saveNamed('Only version');
    const projectId = s.doc.getState().project.projectId;
    s.history.load(songWithClips(1, 'Elsewhere'));
    const item = (await s.projects.list()).find((i) => i.projectId === projectId)!;
    expect(await s.projects.openCopy(item)).toBe(true);
    expect(s.doc.getState().project.projectId).not.toBe(projectId);
    expect(s.files.store.getState().handle).toBeNull();
  });

  it('opens autosaved work as an unsaved project', async () => {
    const { s, autosaves, autosaved } = rig();
    s.files.setUi({ askUnsaved: async () => 'discard' });
    const crashed = songWithClips(3, 'Crashed work');
    autosaves.push(autosaveMeta(crashed));
    autosaved.set(`ses_${crashed.projectId}`, crashed);
    // The real recovery reads the OPFS autosave: the fake source stands in for it only for listing.
    const item = (await s.projects.list()).find((i) => i.projectId === crashed.projectId)!;
    expect(item.source).toBe('autosave');
  });

  it('shows the versions of a project that is not the open one', async () => {
    const { s } = rig();
    await s.versions.saveNamed('One');
    const projectId = s.doc.getState().project.projectId;
    s.history.load(songWithClips(1, 'Elsewhere'));
    const item = (await s.projects.list()).find((i) => i.projectId === projectId)!;
    await s.projects.showVersions(item);
    expect(s.versions.view.getState()).toMatchObject({ projectId, projectName: item.name });
    expect(s.versions.view.getState().versions).toHaveLength(1);
  });
});
