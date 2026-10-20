import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiCommands } from '@app/ai/commands';
import { runReadTool } from '@app/ai/read';
import { READ_TOOLS } from '@app/mcp/read-tools';
import { memoryKv } from '@app/storage/kv';
import { createTestServices } from '@app/testing';
import { memoryVersionFiles } from '@app/versions/memory';
import { seededBytes, setIdSource } from '@core/model/ids';
import { songWithClips } from '@core/versions/test-songs';
import { registerFeatures } from '..';

const START = Date.parse('2026-10-20T12:00:00Z');

beforeEach(() => {
  setIdSource(seededBytes(31));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

/** Runs a command and waits for it to finish (the registry's own `run` does not wait). */
const run = (s: ReturnType<typeof createTestServices>, id: string, argument?: unknown) => s.commands.get(id)!.run(s, argument);

function rig() {
  const s = createTestServices({
    project: songWithClips(2, 'Night Drive'),
    versionBackend: { kv: memoryKv(), files: memoryVersionFiles() },
    projectSources: { recentFiles: async () => [], autosaves: async () => [], loadAutosave: async () => null },
  });
  registerFeatures(s);
  s.versions.start();
  s.files.setUi({ askUnsaved: async () => 'discard' });
  const edit = (bar: number) =>
    s.history.transact('Add clip', (d) => {
      const id = `clip_cmd_${bar}` as never;
      d.playlist.clips[id] = { kind: 'pattern', id, laneId: d.playlist.laneOrder[0]!, patternId: d.patternOrder[0]!, start: bar * 3840, length: 3840, offset: 0 };
    });
  const toast = () => s.session.getState().toasts.at(-1)?.text ?? '';
  return { s, edit, toast };
}

describe('version commands (for the menus, Studio and AI apps)', () => {
  it('versions.save with a name keeps a named version without asking', async () => {
    const { s, toast } = rig();
    await run(s, 'versions.save', 'Before vocals');
    const [record] = await s.versions.versionsOf(s.doc.getState().project.projectId);
    expect(record).toMatchObject({ name: 'Before vocals', pinned: true });
    expect(toast()).toBe('Saved the version “Before vocals”.');
  });

  it('versions.restore finds a version by part of its name, "latest" or says there is none', async () => {
    const { s, edit, toast } = rig();
    await run(s, 'versions.save', 'Before vocals');
    const atVersion = s.doc.getState().project;
    edit(5);
    await run(s, 'versions.restore', 'before voc');
    expect(s.doc.getState().project).toEqual(atVersion);
    vi.setSystemTime(Date.now() + 5000);
    edit(6);
    await run(s, 'versions.save', 'Newer');
    vi.setSystemTime(Date.now() + 5000);
    edit(7);
    await run(s, 'versions.restore', 'latest');
    const clips = Object.keys(s.doc.getState().project.playlist.clips);
    expect(clips).toContain('clip_cmd_6');
    expect(clips).not.toContain('clip_cmd_7');
    await run(s, 'versions.restore', 'no such thing');
    expect(toast()).toMatch(/There is no version called “no such thing”/);
  });

  it('restore and open as a copy wait for the musician’s click when Studio asks (they replace the song)', () => {
    const { s } = rig();
    const catalog = aiCommands(s);
    for (const id of ['versions.restore', 'versions.openCopy', 'projects.open']) {
      const entry = catalog.find((c) => c.id === id);
      expect(entry, id).toBeTruthy();
      expect(s.commands.get(id)!.gesture, id).toBe(true);
      expect(s.commands.get(id)!.argsHint, id).toBeTruthy();
    }
    expect(s.commands.get('versions.save')!.gesture).toBeFalsy();
    expect(catalog.find((c) => c.id === 'versions.save')).toBeTruthy();
  });

  it('versions.keep pins, and versions.openCopy opens a new unsaved project', async () => {
    const { s, edit } = rig();
    const originalId = s.doc.getState().project.projectId;
    edit(3);
    await run(s, 'versions.save', 'Take 1');
    await s.versions.setPinned((await s.versions.find('Take 1'))!, false);
    await run(s, 'versions.keep', 'take 1');
    expect((await s.versions.find('Take 1'))!.pinned).toBe(true);
    edit(9);
    await run(s, 'versions.openCopy', 'Take 1');
    expect(s.doc.getState().project.projectId).not.toBe(originalId);
    expect(s.history.status().dirty).toBe(true);
  });

  it('projects.open opens a project by name', async () => {
    const { s, toast } = rig();
    await s.versions.saveNamed('A');
    const projectId = s.doc.getState().project.projectId;
    s.history.load(songWithClips(1, 'Elsewhere'));
    await s.projects.refresh();
    // The card is named after the file ("Untitled" until it is saved).
    await run(s, 'projects.open', 'untitled');
    expect(s.doc.getState().project.projectId).toBe(projectId);
    await run(s, 'projects.open', 'nonexistent');
    expect(toast()).toMatch(/There is no project called/);
  });
});

describe('read tools for versions and projects', () => {
  it('get_versions lists the open project’s versions with what changed and the storage they use', async () => {
    const { s, edit } = rig();
    await s.versions.saveNamed('First');
    edit(4);
    edit(5);
    await s.versions.saveNamed('Second');
    await s.versions.settled();
    await s.versions.refresh();
    const result = runReadTool(s, 'get_versions', {}) as { versions: Array<{ title: string; changes: string; kept_forever: boolean }>; total: number; automatic: unknown; storage: { versions: number } };
    expect(result.total).toBe(2);
    expect(result.versions.map((v) => v.title)).toEqual(['Second', 'First']);
    expect(result.versions[0]).toMatchObject({ changes: '+2 clips', kept_forever: true });
    expect(result.automatic).toEqual({ every_minutes: 10 });
    expect(result.storage.versions).toBe(2);
    const filtered = runReadTool(s, 'get_versions', { name: 'first', limit: 5 }) as { versions: unknown[]; matching: number };
    expect(filtered.versions).toHaveLength(1);
    expect(filtered.matching).toBe(1);
  });

  it('says so when there are none, or when this browser cannot keep any', async () => {
    const { s } = rig();
    expect((runReadTool(s, 'get_versions', {}) as { note: string }).note).toMatch(/No versions yet/);
    const without = createTestServices({ versionBackend: null });
    expect((runReadTool(without, 'get_versions', {}) as { note: string }).note).toMatch(/cannot keep versions/);
  });

  it('get_recent_projects lists the remembered projects with their numbers, and filters by words', async () => {
    const { s } = rig();
    await s.versions.saveNamed('Keep');
    await s.projects.refresh();
    const result = runReadTool(s, 'get_recent_projects', {}) as { projects: Array<{ name: string; bpm: number; bars: number; versions: number; open?: boolean }>; total: number };
    expect(result.total).toBe(1);
    expect(result.projects[0]).toMatchObject({ bars: 2, versions: 1, open: true });
    const none = runReadTool(s, 'get_recent_projects', { query: 'zzz' }) as { projects: unknown[] };
    expect(none.projects).toEqual([]);
  });

  it('over MCP the tools read storage again first, so the answer is current', async () => {
    const { s } = rig();
    await s.versions.saveNamed('Over MCP');
    // Another tab made a version: only a fresh read sees it.
    const kv = (s.versions.store as unknown as { deps: { kv: ReturnType<typeof memoryKv> } }).deps.kv;
    const records = await s.versions.versionsOf(s.doc.getState().project.projectId);
    await kv.set([[`version:${records[0]!.projectId}:ver_other`, { ...records[0]!, id: 'ver_other', name: 'From another tab', createdAt: records[0]!.createdAt + 1000 }]]);
    const result = await READ_TOOLS.get_versions!(s, {}, {} as never);
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toContain('From another tab');
  });
});
