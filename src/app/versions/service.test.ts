import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { Project } from '@core/model/types';
import { emptySong, songWithClips, withClip } from '@core/versions/test-songs';
import { versionTitle } from '@core/versions/types';
import { applyAnswer } from '../ai/apply';
import { tidyNow } from '../actions/tidy';
import { createTestServices } from '../testing';
import { memoryKv } from '../storage/kv';
import { BIG_EDIT_MIN_GAP_MS, BIG_EDIT_PATCH_COUNT } from './service';
import { memoryVersionFiles } from './memory';

const MINUTE = 60_000;
const START = Date.parse('2026-10-20T12:00:00Z');

beforeEach(() => {
  setIdSource(seededBytes(5));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

function rig(project: Project = songWithClips(2, 'Night Drive')) {
  const kv = memoryKv();
  const files = memoryVersionFiles();
  const s = createTestServices({ project, versionBackend: { kv, files } });
  const stop = s.versions.start();
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  /** An edit that adds a clip at `bar`. */
  const edit = (bar: number) =>
    s.history.transact('Add clip', (draft) => {
      const patternId = draft.patternOrder[0]!;
      const laneId = draft.playlist.laneOrder[0]!;
      const id = `clip_${bar}` as never;
      draft.playlist.clips[id] = { kind: 'pattern', id, laneId, patternId, start: bar * 3840, length: 3840, offset: 0 };
    });
  const versions = async () => {
    await s.versions.settled();
    return s.versions.versionsOf(s.doc.getState().project.projectId);
  };
  const saved = () => (s.files as unknown as { saved(name: string): void }).saved('Night Drive.agproj');
  return { s, kv, files, stop, advance, edit, versions, saved };
}

describe('save points: when they are made', () => {
  it('makes one when the project is saved, if it changed', async () => {
    const { s, edit, versions, saved, stop } = rig();
    edit(5);
    saved();
    await s.versions.settled();
    const list = await versions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ reason: 'save', title: expect.any(String) });
    stop();
  });

  it('does not make one when a save finds nothing changed since the last version', async () => {
    const { s, edit, versions, saved, stop } = rig();
    edit(5);
    saved();
    await s.versions.settled();
    saved();
    expect(await versions()).toHaveLength(1);
    stop();
  });

  it('makes one after the minutes of editing are up, not before', async () => {
    const { s, edit, advance, versions, stop } = rig();
    edit(5);
    advance(9 * MINUTE);
    s.versions.checkTimer();
    expect(await versions()).toHaveLength(0);
    advance(2 * MINUTE);
    s.versions.checkTimer();
    const list = await versions();
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toBe('timer');
    // The clock starts again with the next edit.
    s.versions.checkTimer();
    expect(await versions()).toHaveLength(1);
    stop();
  });

  it('counts the minutes from the first edit since the last version', async () => {
    const { s, edit, advance, versions, stop } = rig();
    edit(5);
    advance(8 * MINUTE);
    edit(6);
    advance(3 * MINUTE);
    s.versions.checkTimer();
    expect(await versions()).toHaveLength(1);
    stop();
  });

  it('makes none when nothing was edited, and none when save points are switched off', async () => {
    const { s, edit, advance, versions, stop } = rig();
    advance(30 * MINUTE);
    s.versions.checkTimer();
    expect(await versions()).toHaveLength(0);
    s.versions.settings.setState({ isAutomatic: false });
    edit(5);
    advance(30 * MINUTE);
    s.versions.checkTimer();
    s.versions.beforeBigChange('before-ai', 'x');
    s.versions.saveBeforeClosing();
    expect(await versions()).toHaveLength(0);
    stop();
  });

  it('makes one before an AI answer even when the project was only just opened', async () => {
    const { s, versions, stop } = rig();
    s.versions.beforeBigChange('before-ai', 'add a bass line');
    const [only] = await versions();
    expect(only).toMatchObject({ reason: 'before-ai', note: 'add a bass line' });
    expect(versionTitle(only!)).toBe('Before a Studio answer: add a bass line');
    stop();
  });

  it('holds the state from before the big change, not after it', async () => {
    const { s, versions, edit, stop } = rig();
    s.versions.beforeBigChange('before-arrange', 'develop the song');
    edit(9);
    const [only] = await versions();
    const kept = await s.versions.store!.read(only!);
    expect(Object.keys(kept.project.playlist.clips)).toHaveLength(2);
    expect(Object.keys(s.doc.getState().project.playlist.clips)).toHaveLength(3);
    stop();
  });

  it('makes one before a very large single edit, with the project as it was, and not again within two minutes', async () => {
    const { s, versions, advance, stop } = rig();
    const big = (offset: number) =>
      s.history.transact('Paste', (draft) => {
        for (let i = 0; i < BIG_EDIT_PATCH_COUNT + 10; i++) {
          const id = `clip_big_${offset}_${i}` as never;
          draft.playlist.clips[id] = {
            kind: 'pattern',
            id,
            laneId: draft.playlist.laneOrder[1]!,
            patternId: draft.patternOrder[0]!,
            start: (offset + i) * 3840,
            length: 3840,
            offset: 0,
          };
        }
      });
    big(100);
    const first = await versions();
    expect(first).toHaveLength(1);
    expect(first[0]!.reason).toBe('before-big');
    expect(first[0]!.facts.clips).toBe(2);
    advance(BIG_EDIT_MIN_GAP_MS / 2);
    big(1000);
    expect(await versions()).toHaveLength(1);
    advance(BIG_EDIT_MIN_GAP_MS);
    big(5000);
    expect(await versions()).toHaveLength(2);
    stop();
  });

  it('makes one before an AI answer is applied, holding the project as it was', async () => {
    const { s, versions, stop } = rig();
    applyAnswer(s, { message: 'Make it faster.', actions: [{ op: 'song', bpm: 160 }] }, { previousBeat: null });
    const [only] = await versions();
    expect(only).toMatchObject({ reason: 'before-ai', note: 'Make it faster' });
    expect((await s.versions.store!.read(only!)).project.transport.bpm).toBe(130);
    expect(s.doc.getState().project.transport.bpm).toBe(160);
    stop();
  });

  it('does not make one for a dry run of an answer', async () => {
    const { s, versions, stop } = rig();
    applyAnswer(s, { message: 'Faster', actions: [{ op: 'song', bpm: 160 }] }, { previousBeat: null, dryRun: true });
    expect(await versions()).toHaveLength(0);
    stop();
  });

  it('makes one before "clean up the song"', async () => {
    const { s, versions, stop } = rig();
    tidyNow(s);
    const [only] = await versions();
    expect(only!.reason).toBe('before-tidy');
    stop();
  });

  it('makes one when the tab closes with changes, and not when there are none', async () => {
    const { s, edit, versions, stop } = rig();
    s.versions.saveBeforeClosing();
    expect(await versions()).toHaveLength(0);
    edit(7);
    s.versions.saveBeforeClosing();
    const list = await versions();
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toBe('close');
    stop();
  });

  it('keeps a version the musician asks for, named and pinned', async () => {
    const { s, edit, versions, stop } = rig();
    edit(5);
    const record = await s.versions.saveNamed('Before vocals');
    expect(record).toMatchObject({ name: 'Before vocals', pinned: true, reason: 'named' });
    expect(await versions()).toHaveLength(1);
    stop();
  });

  it('gives an unnamed request a name with the time', async () => {
    const { s, edit, stop } = rig();
    edit(5);
    const record = await s.versions.saveNamed('  ');
    expect(record!.name).toMatch(/^Version of /);
    stop();
  });

  it('starts a fresh baseline when another project is opened', async () => {
    const { s, edit, versions, stop } = rig();
    edit(5);
    s.history.load(songWithClips(1, 'Another'));
    s.versions.saveBeforeClosing();
    expect(await versions()).toHaveLength(0);
    stop();
  });

  it('never throws or keeps anything in a browser without storage', async () => {
    const s = createTestServices({ project: songWithClips(1), versionBackend: null });
    expect(s.versions.isAvailable).toBe(false);
    s.versions.start();
    s.versions.beforeBigChange('before-ai');
    expect(await s.versions.savePoint('timer')).toBeNull();
    expect(await s.versions.saveNamed('x')).toBeNull();
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/no private storage/);
  });
});

describe('restoring', () => {
  it('puts the project back exactly, as one undo step, keeping the state it replaced', async () => {
    const { s, edit, versions, stop } = rig();
    edit(5);
    const record = (await s.versions.saveNamed('Good one'))!;
    const atVersion = s.doc.getState().project;
    edit(6);
    edit(7);
    const beforeRestore = s.doc.getState().project;
    const steps = s.history.steps().done.length;

    expect(await s.versions.restore(record)).toBe(true);
    expect(s.doc.getState().project).toEqual(atVersion);
    expect(s.history.steps().done).toHaveLength(steps + 1);
    expect(s.history.status().undoLabel).toBe('Restore version “Good one”');

    // The project as it was before the restore is a version too, so nothing is lost for good.
    const list = await versions();
    const safety = list.find((v) => v.reason === 'before-restore')!;
    expect(safety).toBeDefined();
    expect((await s.versions.store!.read(safety)).project).toEqual(beforeRestore);

    s.history.undo();
    expect(s.doc.getState().project).toEqual(beforeRestore);
    stop();
  });

  it('says so when the project already matches', async () => {
    const { s, edit, stop } = rig();
    edit(5);
    const record = (await s.versions.saveNamed('Same'))!;
    expect(await s.versions.restore(record)).toBe(false);
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/already matches/);
    stop();
  });

  it('will not restore a version of another project into this one', async () => {
    const { s, versions, stop } = rig();
    s.versions.beforeBigChange('before-ai');
    const [mine] = await versions();
    s.history.load(emptySong('Different'));
    expect(await s.versions.restore(mine!)).toBe(false);
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/another project/);
    stop();
  });

  it('opens a version as a new unsaved project with its own identity, leaving the open one alone', async () => {
    const { s, edit, stop } = rig();
    s.files.setUi({ askUnsaved: async () => 'discard' });
    edit(5);
    const record = (await s.versions.saveNamed('Take 1'))!;
    const originalId = s.doc.getState().project.projectId;
    edit(8);
    expect(await s.versions.openAsCopy(record)).toBe(true);
    const copy = s.doc.getState().project;
    expect(copy.projectId).not.toBe(originalId);
    expect(copy.meta.title).toBe('Night Drive (Take 1)');
    expect(Object.keys(copy.playlist.clips)).toHaveLength(3);
    expect(s.files.store.getState()).toMatchObject({ name: 'Night Drive (Take 1)', handle: null, fileKey: null });
    expect(s.history.status().dirty).toBe(true);
    stop();
  });

  it('opens the newest version of a project that has no file, keeping its identity so its history continues', async () => {
    const { s, edit, stop } = rig();
    s.files.setUi({ askUnsaved: async () => 'discard' });
    edit(5);
    const record = (await s.versions.saveNamed('Latest'))!;
    s.history.load(emptySong('Elsewhere'));
    expect(await s.versions.openLatestOf(record.projectId, 'Sketch')).toBe(true);
    expect(s.doc.getState().project.projectId).toBe(record.projectId);
    expect(s.files.store.getState().name).toBe('Sketch');
    stop();
  });

  it('finds a version by name, part of a name, id or "latest"', async () => {
    const { s, edit, stop } = rig();
    edit(5);
    const first = (await s.versions.saveNamed('Before vocals'))!;
    edit(6);
    const second = (await s.versions.saveNamed('After vocals'))!;
    expect((await s.versions.find('before vocals'))!.id).toBe(first.id);
    expect((await s.versions.find('after'))!.id).toBe(second.id);
    expect((await s.versions.find(first.id))!.id).toBe(first.id);
    expect((await s.versions.find('latest'))!.id).toBe(second.id);
    expect(await s.versions.find('nothing like this')).toBeNull();
    stop();
  });

  it('says what changed in the open project since a version', async () => {
    const { s, edit, stop } = rig();
    const record = (await s.versions.saveNamed('Start'))!;
    edit(5);
    edit(6);
    const changes = await s.versions.changesSince(record);
    expect(changes.parts).toEqual(['+2 clips']);
    stop();
  });
});

describe('the list in the window', () => {
  it('shows the open project’s versions and what they take', async () => {
    const { s, edit, stop } = rig();
    edit(5);
    await s.versions.saveNamed('One');
    edit(6);
    await s.versions.saveNamed('Two');
    await s.versions.refresh();
    const view = s.versions.view.getState();
    expect(view.versions.map((v) => v.name)).toEqual(['Two', 'One']);
    expect(view.usage.project.count).toBe(2);
    expect(view.usage.project.bytes).toBe(view.versions.reduce((n, v) => n + v.size, 0));
    stop();
  });

  it('pins, renames and deletes', async () => {
    const { s, edit, stop } = rig();
    edit(5);
    const record = (await s.versions.saveNamed('One'))!;
    await s.versions.setPinned(record, false);
    expect(s.versions.view.getState().versions[0]!.pinned).toBe(false);
    await s.versions.rename(record, 'Renamed');
    expect(s.versions.view.getState().versions[0]).toMatchObject({ name: 'Renamed', pinned: true });
    await s.versions.remove(record);
    expect(s.versions.view.getState().versions).toEqual([]);
    stop();
  });

  it('lists another project’s versions when asked', async () => {
    const { s, edit, stop } = rig();
    edit(5);
    await s.versions.saveNamed('One');
    const otherId = s.doc.getState().project.projectId;
    s.history.load(withClip(emptySong('Other'), 'x' as never, 0));
    await s.versions.showVersionsOf(otherId, 'Night Drive');
    expect(s.versions.view.getState()).toMatchObject({ projectId: otherId, projectName: 'Night Drive' });
    expect(s.versions.view.getState().versions).toHaveLength(1);
    stop();
  });
});
