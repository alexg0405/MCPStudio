import { describe, expect, it } from 'vitest';
import type { ProjectFacts } from '../versions/facts';
import {
  filterProjects,
  isProjectCard,
  mergeProjectList,
  plainFileName,
  sortProjects,
  type AutosaveInfo,
  type ListedProject,
  type ProjectCard,
  type ProjectListInput,
  type RecentFileInfo,
} from './list';

const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  bars: 32,
  lengthSec: 60,
  bpm: 128,
  key: 'A minor',
  clips: 10,
  patterns: 3,
  channels: 5,
  ...over,
});

const card = (projectId: string, over: Partial<ProjectCard> = {}): ProjectCard => ({
  v: 1,
  projectId,
  name: projectId,
  lastOpenedAt: 1000,
  lastModifiedAt: 1000,
  facts: facts(),
  thumbnail: null,
  pinned: false,
  removed: false,
  ...over,
});

const recent = (key: string, name: string, usedAt: string): RecentFileInfo => ({ key, name, usedAt });
const autosave = (projectId: string, over: Partial<AutosaveInfo> = {}): AutosaveInfo => ({
  sessionId: `ses_${projectId}`,
  projectId,
  title: projectId,
  savedAt: '2026-10-20T10:00:00Z',
  clean: false,
  ...over,
});

const input = (over: Partial<ProjectListInput> = {}): ProjectListInput => ({
  cards: [],
  recents: [],
  autosaves: [],
  versions: new Map(),
  ...over,
});

const names = (items: readonly ListedProject[]) => items.map((i) => i.name);

describe('mergeProjectList', () => {
  it('lists a project once however many places remember it', () => {
    const list = mergeProjectList(
      input({
        cards: [card('prj_a', { fileKey: 'file_1', name: 'Old name' })],
        recents: [recent('file_1', 'Night Drive.agproj', '2026-10-20T09:00:00Z')],
        autosaves: [autosave('prj_a', { clean: true, fileKey: 'file_1' })],
        versions: new Map([['prj_a', { count: 4, newestAt: 5, title: 'Night Drive' }]]),
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Night Drive', source: 'file', fileKey: 'file_1', versionCount: 4 });
  });

  it('takes the later of the card’s time and the file’s last use as "last opened"', () => {
    const [item] = mergeProjectList(
      input({
        cards: [card('prj_a', { fileKey: 'f', lastOpenedAt: Date.parse('2026-10-01T00:00:00Z') })],
        recents: [recent('f', 'A.agproj', '2026-10-15T00:00:00Z')],
      }),
    );
    expect(item!.lastOpenedAt).toBe(Date.parse('2026-10-15T00:00:00Z'));
  });

  it('lists a remembered file that has no card yet, by name', () => {
    const [item] = mergeProjectList(input({ recents: [recent('f', 'Old Beat.agproj', '2026-10-10T00:00:00Z')] }));
    expect(item).toMatchObject({ id: 'file:f', name: 'Old Beat', source: 'file', facts: null, versionCount: 0 });
  });

  it('lists unsaved autosaved work that nothing else explains, and says it is unsaved', () => {
    const [item] = mergeProjectList(input({ autosaves: [autosave('prj_crash', { title: 'Crashed song' })] }));
    expect(item).toMatchObject({ name: 'Crashed song', source: 'autosave', sessionId: 'ses_prj_crash', hasUnsavedWork: true });
  });

  it('skips the autosave of a project that was saved cleanly, or that lives in a remembered file', () => {
    const list = mergeProjectList(
      input({
        recents: [recent('f', 'Song.agproj', '2026-10-10T00:00:00Z')],
        autosaves: [autosave('prj_clean', { clean: true }), autosave('prj_filed', { fileKey: 'f' })],
      }),
    );
    expect(names(list)).toEqual(['Song']);
  });

  it('flags a card whose file has newer autosaved changes', () => {
    const [item] = mergeProjectList(
      input({
        cards: [card('prj_a', { fileKey: 'f', lastModifiedAt: Date.parse('2026-10-20T09:00:00Z') })],
        recents: [recent('f', 'A.agproj', '2026-10-20T09:00:00Z')],
        autosaves: [autosave('prj_a', { savedAt: '2026-10-20T09:30:00Z', fileKey: 'f' })],
      }),
    );
    expect(item!.hasUnsavedWork).toBe(true);
  });

  it('opens a project that has versions and no file from its newest version', () => {
    const [item] = mergeProjectList(input({ cards: [card('prj_v', { name: 'Sketch' })], versions: new Map([['prj_v', { count: 2, newestAt: 9, title: 'Sketch' }]]) }));
    expect(item).toMatchObject({ source: 'versions', versionCount: 2 });
  });

  it('lists a project that only has versions even without a card', () => {
    const [item] = mergeProjectList(input({ versions: new Map([['prj_only', { count: 1, newestAt: 7, title: 'Only versions' }]]) }));
    expect(item).toMatchObject({ name: 'Only versions', source: 'versions', projectId: 'prj_only', lastOpenedAt: 7 });
  });

  it('leaves out a card with nothing to open and one the musician removed', () => {
    const list = mergeProjectList(
      input({
        cards: [card('prj_nothing'), card('prj_gone', { removed: true, fileKey: 'f2' })],
        recents: [recent('f2', 'Gone.agproj', '2026-10-10T00:00:00Z')],
        versions: new Map([['prj_gone', { count: 3, newestAt: 1, title: 'Gone' }]]),
      }),
    );
    expect(list).toEqual([]);
  });

  it('marks the open project', () => {
    const list = mergeProjectList(
      input({
        cards: [card('prj_a', { fileKey: 'a' }), card('prj_b', { fileKey: 'b' })],
        recents: [recent('a', 'A.agproj', '2026-10-10T00:00:00Z'), recent('b', 'B.agproj', '2026-10-10T00:00:00Z')],
        openProjectId: 'prj_b',
      }),
    );
    expect(list.find((i) => i.isOpen)?.name).toBe('B');
  });
});

describe('sortProjects', () => {
  const items = mergeProjectList(
    input({
      cards: [
        card('prj_1', { name: 'Charlie', fileKey: 'k1', lastOpenedAt: 300, lastModifiedAt: 100, facts: facts({ lengthSec: 30, bpm: 140 }) }),
        card('prj_2', { name: 'alpha', fileKey: 'k2', lastOpenedAt: 100, lastModifiedAt: 300, facts: facts({ lengthSec: 200, bpm: 90 }) }),
        card('prj_3', { name: 'Bravo', fileKey: 'k3', lastOpenedAt: 200, lastModifiedAt: 200, pinned: true, facts: facts({ lengthSec: 100, bpm: 120 }) }),
      ],
      recents: [recent('k1', 'Charlie.agproj', '1970-01-01T00:00:00Z'), recent('k2', 'alpha.agproj', '1970-01-01T00:00:00Z'), recent('k3', 'Bravo.agproj', '1970-01-01T00:00:00Z')],
    }),
  );

  it('puts pinned projects first, then the most recently opened', () => {
    expect(names(sortProjects(items, 'recent'))).toEqual(['Bravo', 'Charlie', 'alpha']);
  });

  it('sorts by last changed, name (ignoring case), length and tempo', () => {
    expect(names(sortProjects(items, 'modified'))).toEqual(['Bravo', 'alpha', 'Charlie']);
    expect(names(sortProjects(items, 'name'))).toEqual(['Bravo', 'alpha', 'Charlie']);
    expect(names(sortProjects(items, 'length'))).toEqual(['Bravo', 'alpha', 'Charlie']);
    expect(names(sortProjects(items, 'tempo'))).toEqual(['Bravo', 'alpha', 'Charlie']);
  });

  it('orders unpinned ones too when nothing is pinned', () => {
    const unpinned = items.map((i) => ({ ...i, pinned: false }));
    expect(names(sortProjects(unpinned, 'name'))).toEqual(['alpha', 'Bravo', 'Charlie']);
    expect(names(sortProjects(unpinned, 'length'))).toEqual(['alpha', 'Bravo', 'Charlie']);
    expect(names(sortProjects(unpinned, 'tempo'))).toEqual(['alpha', 'Bravo', 'Charlie']);
    expect(names(sortProjects(unpinned, 'recent'))).toEqual(['Charlie', 'Bravo', 'alpha']);
  });

  it('breaks ties by name so the order never jumps around', () => {
    const tied = [
      { ...items[0]!, id: 'x', name: 'Same', lastOpenedAt: 5, pinned: false },
      { ...items[0]!, id: 'a', name: 'Same', lastOpenedAt: 5, pinned: false },
      { ...items[0]!, id: 'm', name: 'Alpha', lastOpenedAt: 5, pinned: false },
    ];
    expect(sortProjects(tied, 'recent').map((i) => i.id)).toEqual(['m', 'a', 'x']);
    expect(sortProjects([...tied].reverse(), 'recent').map((i) => i.id)).toEqual(['m', 'a', 'x']);
  });

  it('does not change the list it is given', () => {
    const before = items.map((i) => i.id);
    sortProjects(items, 'name');
    expect(items.map((i) => i.id)).toEqual(before);
  });
});

describe('filterProjects', () => {
  const items = mergeProjectList(
    input({
      cards: [
        card('prj_1', { name: 'Night Drive', fileKey: 'k1', facts: facts({ key: 'F minor', bpm: 140 }) }),
        card('prj_2', { name: 'Morning Run', fileKey: 'k2', facts: facts({ key: 'C major', bpm: 100 }) }),
      ],
      recents: [recent('k1', 'Night Drive.agproj', '2026-10-01T00:00:00Z'), recent('k2', 'Morning Run.agproj', '2026-10-02T00:00:00Z')],
    }),
  );

  it('finds by any words of the name, in any order and case', () => {
    expect(names(filterProjects(items, 'drive night'))).toEqual(['Night Drive']);
    expect(names(filterProjects(items, 'RUN'))).toEqual(['Morning Run']);
  });

  it('finds by key and by tempo', () => {
    expect(names(filterProjects(items, 'f minor'))).toEqual(['Night Drive']);
    expect(names(filterProjects(items, '100 bpm'))).toEqual(['Morning Run']);
  });

  it('matches everything for an empty query and nothing for a stranger', () => {
    expect(filterProjects(items, '   ')).toHaveLength(2);
    expect(filterProjects(items, 'zzz')).toEqual([]);
  });
});

describe('small helpers', () => {
  it('plainFileName drops the extension and never returns an empty name', () => {
    expect(plainFileName('Song.agproj')).toBe('Song');
    expect(plainFileName('Song.AGPROJ')).toBe('Song');
    expect(plainFileName('.agproj')).toBe('Untitled');
  });

  it('isProjectCard refuses damaged records', () => {
    expect(isProjectCard(card('prj_a'))).toBe(true);
    expect(isProjectCard({ ...card('prj_a'), facts: undefined })).toBe(false);
    expect(isProjectCard('nope')).toBe(false);
  });
});
