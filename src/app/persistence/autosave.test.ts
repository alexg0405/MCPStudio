import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProjectFile } from '@core/io/project-file';
import { createEmptyProject } from '@core/model/defaults';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { Project } from '@core/model/types';
import { StorageError, type AutosaveMeta, type AutosaveSlot } from '@platform/opfs';
import {
  loadAutosave,
  pruneAutosaves,
  selectRecoveryCandidates,
  startAutosave,
  type AutosaveOptions,
} from './autosave';
import { createMemoryBlobStore } from './blob-store';

const T0 = Date.parse('2026-10-12T12:00:00.000Z');

interface Write {
  sessionId: string;
  slot: AutosaveSlot;
  data: Uint8Array;
  meta: AutosaveMeta;
  at: number;
}

function setup(over: Partial<AutosaveOptions> = {}) {
  let project: Project = createEmptyProject({ title: 'Song', now: new Date(0) });
  let edits = 0;
  const listeners = new Set<() => void>();
  const hidden = new Set<() => void>();
  const pageHide = new Set<() => void>();
  const writes: Write[] = [];
  const storage = {
    writeAutosave: vi.fn(async (sessionId: string, slot: AutosaveSlot, data: Uint8Array, meta: AutosaveMeta) => {
      writes.push({ sessionId, slot, data, meta, at: Date.now() - T0 });
    }),
    markAutosaveClean: vi.fn(async (_sessionId: string) => {}),
  };
  const onError = vi.fn();
  const autosave = startAutosave({
    sessionId: 's1',
    getSnapshot: () => ({ project, view: { mode: 'pattern', edits } }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    appVersion: '0.1.0',
    storage,
    lifecycle: {
      onHidden: (fn) => (hidden.add(fn), () => hidden.delete(fn)),
      onPageHide: (fn) => (pageHide.add(fn), () => pageHide.delete(fn)),
    },
    onError,
    ...over,
  });
  return {
    autosave,
    writes,
    storage,
    onError,
    listeners,
    hidden,
    pageHide,
    get project() {
      return project;
    },
    edit() {
      edits++;
      project = { ...project, meta: { ...project.meta, title: `Song ${edits}` } };
      for (const fn of listeners) fn();
    },
    hide: () => hidden.forEach((fn) => fn()),
    leave: () => pageHide.forEach((fn) => fn()),
  };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  setIdSource(seededBytes(3));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startAutosave', () => {
  it('saves 3 s after the last change', async () => {
    const t = setup();
    t.edit();
    await advance(2999);
    expect(t.writes).toHaveLength(0);
    await advance(1);
    expect(t.writes.map((w) => w.at)).toEqual([3000]);
    await advance(60_000);
    expect(t.writes).toHaveLength(1); // nothing new to save
  });

  it('debounces a burst of changes into one save', async () => {
    const t = setup();
    t.edit();
    await advance(1000);
    t.edit();
    await advance(1000);
    t.edit();
    await advance(10_000);
    expect(t.writes.map((w) => w.at)).toEqual([5000]);
    expect(t.writes[0]!.meta.title).toBe('Song 3');
  });

  it('saves at least every 30 s while changes keep coming', async () => {
    const t = setup();
    for (let s = 0; s < 65; s++) {
      t.edit();
      await advance(1000);
    }
    await advance(10_000);
    expect(t.writes.map((w) => w.at)).toEqual([30_000, 60_000, 67_000]);
  });

  it('alternates slots A and B', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) {
      t.edit();
      await advance(3000);
    }
    expect(t.writes.map((w) => w.slot)).toEqual(['a', 'b', 'a']);
  });

  it('writes a thin project file and a complete meta', async () => {
    const t = setup({ fileKey: () => 'file:abc' });
    t.edit();
    await advance(3000);
    const [w] = t.writes;
    expect(w!.sessionId).toBe('s1');
    expect(w!.meta).toEqual({
      sessionId: 's1',
      projectId: t.project.projectId,
      title: 'Song 1',
      savedAt: new Date(T0 + 3000).toISOString(),
      clean: false,
      slot: 'a',
      fileKey: 'file:abc',
    });
    const file = readProjectFile(w!.data);
    expect(file.project).toEqual(t.project);
    expect(file.view).toEqual({ mode: 'pattern', edits: 1 });
    expect(file.samples.size).toBe(0);
    expect(file.meta).toEqual({ format: 1, appVersion: '0.1.0', savedAt: new Date(T0 + 3000).toISOString() });
  });

  it('omits fileKey when there is none', async () => {
    const t = setup({ fileKey: () => undefined });
    t.edit();
    await advance(3000);
    expect('fileKey' in t.writes[0]!.meta).toBe(false);
  });

  it('saves right away when the tab is hidden', async () => {
    const t = setup();
    t.hide();
    await advance(0);
    expect(t.writes).toHaveLength(0); // nothing to save
    t.edit();
    await advance(500);
    t.hide();
    await advance(0);
    expect(t.writes.map((w) => w.at)).toEqual([500]);
    await advance(30_000);
    expect(t.writes).toHaveLength(1); // the pending debounce was cancelled
  });

  it('marks the session clean on pagehide after a successful save', async () => {
    const t = setup();
    t.edit();
    t.leave();
    await advance(0);
    expect(t.writes).toHaveLength(1);
    expect(t.storage.markAutosaveClean).toHaveBeenCalledWith('s1');
    // Order: the save comes before the clean mark.
    expect(t.storage.writeAutosave.mock.invocationCallOrder[0]!).toBeLessThan(
      t.storage.markAutosaveClean.mock.invocationCallOrder[0]!,
    );
  });

  it('does not mark clean when nothing was ever saved or the save failed', async () => {
    const idle = setup();
    idle.leave();
    await advance(0);
    expect(idle.storage.markAutosaveClean).not.toHaveBeenCalled();

    const t = setup();
    t.storage.writeAutosave.mockRejectedValueOnce(new Error('disk on fire'));
    t.edit();
    t.leave();
    await advance(0);
    expect(t.storage.markAutosaveClean).not.toHaveBeenCalled();
    expect(t.onError).toHaveBeenCalledWith(new Error('disk on fire'));
  });

  it('retries a failed save into the same slot', async () => {
    const t = setup();
    t.storage.writeAutosave.mockRejectedValueOnce(new StorageError('quota', 'full'));
    t.edit();
    await advance(3000);
    expect(t.onError).toHaveBeenCalledTimes(1);
    expect(t.storage.writeAutosave).toHaveBeenCalledTimes(1);
    // No further edits: the retry comes after the max wait, not every 3 s.
    await advance(29_999);
    expect(t.storage.writeAutosave).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(t.writes.map((w) => [w.at, w.slot])).toEqual([[33_000, 'a']]);
    t.edit();
    await advance(3000);
    expect(t.writes.map((w) => w.slot)).toEqual(['a', 'b']);
  });

  it('gives up quietly when storage is unavailable', async () => {
    const t = setup();
    t.storage.writeAutosave.mockRejectedValue(new StorageError('unavailable', 'no OPFS'));
    t.edit();
    await advance(3000);
    for (let i = 0; i < 5; i++) {
      t.edit();
      await advance(31_000);
    }
    t.hide();
    await t.autosave.flush();
    expect(t.storage.writeAutosave).toHaveBeenCalledTimes(1);
    expect(t.onError).toHaveBeenCalledTimes(1);
  });

  it('flush() saves immediately and coalesces concurrent calls', async () => {
    const t = setup();
    await t.autosave.flush();
    expect(t.writes).toHaveLength(0);
    t.edit();
    const a = t.autosave.flush();
    const b = t.autosave.flush();
    await Promise.all([a, b]);
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0]!.at).toBe(0);
  });

  it('saves again after a write in progress when changes arrived meanwhile', async () => {
    const t = setup();
    let finish: () => void = () => {};
    t.storage.writeAutosave.mockImplementationOnce(
      async (sessionId: string, slot: AutosaveSlot, data: Uint8Array, meta: AutosaveMeta) => {
        await new Promise<void>((r) => (finish = r));
        t.writes.push({ sessionId, slot, data, meta, at: Date.now() - T0 });
      },
    );
    t.edit();
    const first = t.autosave.flush();
    await advance(0);
    t.edit(); // lands while the first write is still running
    const second = t.autosave.flush();
    finish();
    await Promise.all([first, second]);
    expect(t.writes.map((w) => [w.slot, w.meta.title])).toEqual([
      ['a', 'Song 1'],
      ['b', 'Song 2'],
    ]);
  });

  it('reports a failing snapshot and keeps the change pending', async () => {
    let fail = true;
    const project = createEmptyProject();
    const t = setup({
      getSnapshot: () => {
        if (fail) throw new Error('snapshot broke');
        return { project, view: null };
      },
    });
    t.edit();
    await advance(3000);
    expect(t.onError).toHaveBeenCalledWith(new Error('snapshot broke'));
    expect(t.writes).toHaveLength(0);
    fail = false;
    await t.autosave.flush();
    expect(t.writes.map((w) => w.slot)).toEqual(['a']);
  });

  it('flush() rejects when the save fails', async () => {
    const t = setup();
    t.storage.writeAutosave.mockRejectedValueOnce(new Error('nope'));
    t.edit();
    await expect(t.autosave.flush()).rejects.toThrow('nope');
    await t.autosave.flush(); // still dirty: saved now
    expect(t.writes).toHaveLength(1);
  });

  it('stop() cancels pending saves and removes listeners', async () => {
    const t = setup();
    t.edit();
    t.autosave.stop();
    t.autosave.stop();
    await advance(60_000);
    expect(t.writes).toHaveLength(0);
    expect(t.listeners.size).toBe(0);
    expect(t.hidden.size).toBe(0);
    expect(t.pageHide.size).toBe(0);
    await t.autosave.flush(); // an explicit flush still saves
    expect(t.writes).toHaveLength(1);
  });

  it('works without a DOM using the default lifecycle', async () => {
    const t = setup({ lifecycle: undefined });
    t.edit();
    await advance(3000);
    expect(t.writes).toHaveLength(1);
    t.autosave.stop();
  });
});

describe('recovery candidates', () => {
  const meta = (sessionId: string, projectId: string, savedAt: string, clean = false): AutosaveMeta => ({
    sessionId,
    projectId,
    title: projectId,
    savedAt,
    clean,
    slot: 'a',
  });

  it('keeps dirty, unlocked sessions of other tabs, newest first, one per project', () => {
    const metas = [
      meta('old', 'p1', '2026-10-10T00:00:00.000Z'),
      meta('newer', 'p1', '2026-10-11T00:00:00.000Z'),
      meta('clean', 'p2', '2026-10-12T00:00:00.000Z', true),
      meta('live', 'p3', '2026-10-12T01:00:00.000Z'),
      meta('me', 'p4', '2026-10-12T02:00:00.000Z'),
      meta('crash', 'p5', '2026-10-09T00:00:00.000Z'),
      meta('weird', 'p6', 'not a date'),
    ];
    const snapshot = JSON.parse(JSON.stringify(metas));
    const picked = selectRecoveryCandidates(metas, new Set(['live']), 'me');
    expect(picked.map((m) => m.sessionId)).toEqual(['newer', 'crash', 'weird']);
    expect(metas).toEqual(snapshot); // input untouched
  });

  it('returns nothing when every session is accounted for', () => {
    expect(selectRecoveryCandidates([], new Set(), 'me')).toEqual([]);
    expect(selectRecoveryCandidates([meta('a', 'p', '2026-01-01T00:00:00Z', true)], new Set(), 'me')).toEqual([]);
  });

  it('prunes all but the newest autosaves, never protected ones', () => {
    const metas = Array.from({ length: 8 }, (_, i) =>
      meta(`s${i}`, `p${i}`, new Date(Date.UTC(2026, 9, 1 + i)).toISOString()),
    );
    expect(pruneAutosaves(metas)).toEqual(['s2', 's1', 's0']);
    expect(pruneAutosaves(metas, 6)).toEqual(['s1', 's0']);
    expect(pruneAutosaves(metas, 0)).toHaveLength(8);
    expect(pruneAutosaves(metas, 20)).toEqual([]);
    expect(pruneAutosaves(metas, 2, new Set(['s7', 's0']))).toEqual(['s4', 's3', 's2', 's1']);
  });
});

describe('loadAutosave', () => {
  it('opens the newest autosave of a session', async () => {
    vi.useRealTimers();
    const store = createMemoryBlobStore();
    let saved: { data: Uint8Array; meta: AutosaveMeta } | null = null;
    const t = setup({
      storage: {
        writeAutosave: async (_s, _slot, data, meta) => void (saved = { data, meta }),
        markAutosaveClean: async () => {},
      },
    });
    t.edit();
    await t.autosave.flush();
    const opened = await loadAutosave('s1', { storage: { readAutosave: async () => saved }, store });
    expect(opened?.project).toEqual(t.project);
    expect(opened?.meta.sessionId).toBe('s1');
    expect(opened?.repairs).toEqual([]);
    expect(await loadAutosave('s1', { storage: { readAutosave: async () => null }, store })).toBeNull();
  });
});
