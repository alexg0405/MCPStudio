import { describe, expect, it } from 'vitest';
import { History } from '../history/history';
import type { Project } from '../model/types';
import { emptySong, songWithClips, withClip, withFader, withPattern } from '../versions/test-songs';
import { restoreProject } from './restore';

function historyOf(initial: Project): { history: History; read(): Project } {
  let project = initial;
  const history = new History({ get: () => project, set: (next) => (project = next) });
  return { history, read: () => project };
}

describe('restoreProject', () => {
  it('makes the document equal an earlier state exactly, in one undo step', () => {
    const early = songWithClips(2);
    let later = withFader(withClip(early, early.patternOrder[0]!, 5), 1, 0.5);
    later = withPattern(later, 'Drop 2').project;
    const { history, read } = historyOf(later);
    history.transact('Restore', (draft) => restoreProject(draft, history.project, early));
    expect(read()).toEqual(early);
    expect(history.steps().done).toHaveLength(1);
    history.undo();
    expect(read()).toEqual(later);
    history.redo();
    expect(read()).toEqual(early);
  });

  it('leaves the parts that did not change as the very same objects', () => {
    const early = songWithClips(2);
    const later = withFader(early, 1, 0.5);
    const { history, read } = historyOf(later);
    history.transact('Restore', (draft) => restoreProject(draft, history.project, early));
    expect(read().playlist).toBe(later.playlist);
    expect(read().patterns).toBe(later.patterns);
    expect(read().mixer.inserts[early.mixer.order[2]!]).toBe(later.mixer.inserts[early.mixer.order[2]!]);
  });

  it('keeps the open project’s identity', () => {
    const early = emptySong('Early');
    const later = { ...songWithClips(3, 'Later'), projectId: 'prj_open' };
    const { history, read } = historyOf(later);
    history.transact('Restore', (draft) => restoreProject(draft, history.project, early));
    expect(read().projectId).toBe('prj_open');
    expect(read().meta.title).toBe('Early');
  });

  it('is no change at all when the document already matches', () => {
    const song = songWithClips(2);
    const { history } = historyOf(song);
    const copy = structuredClone(song);
    expect(history.transact('Restore', (draft) => restoreProject(draft, history.project, copy))).toBe(false);
    expect(history.status().canUndo).toBe(false);
  });

  it('brings back optional parts that were removed, and removes ones added since', () => {
    const early = { ...emptySong(), chords: { c1: { id: 'c1', tick: 0, length: 3840, root: 0, quality: 'maj' } } } as unknown as Project;
    const later = emptySong();
    const first = historyOf(later);
    first.history.transact('Restore', (draft) => restoreProject(draft, first.history.project, early));
    expect(first.read().chords).toEqual(early.chords);
    const second = historyOf(early);
    second.history.transact('Restore', (draft) => restoreProject(draft, second.history.project, later));
    expect('chords' in second.read()).toBe(false);
  });
});
