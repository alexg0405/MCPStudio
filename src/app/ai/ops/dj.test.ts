import { afterEach, describe, expect, it } from 'vitest';
import { fakeAnalysis } from '@core/dj/fake-analysis';
import type { TrackAnalysis } from '@core/dj/types';
import { newId } from '@core/model/ids';
import { fakeAnalyzer, setTrackAnalyzer } from '../../dj/analyzer';
import { djMixStep } from '../../dj/step';
import { library, type LibrarySong } from '../../dj/library';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { projectContext } from '../context';
import { STUDIO_PROMPT } from '../prompt';
import type { AiAction } from '../schema';

type S = ReturnType<typeof createTestServices>;
const run = (s: S, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });

const hex = (name: string) => [...name].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64);

function setup(analyzeFirst: boolean) {
  const specs = [
    ['Nova – Midnight Run', 124, 9],
    ['Kairo – Glass City', 126, 4],
    ['Lumen – Higher', 128, 11],
  ] as const;
  const byHash = new Map<string, TrackAnalysis>();
  const songs: LibrarySong[] = specs.map(([label, bpm, root]) => {
    const key = hex(label);
    byHash.set(key, fakeAnalysis({ bpm, key: { root, mode: 'minor' }, bars: 96, hash: key }));
    return {
      key,
      ref: { id: newId.sample(), name: label, source: { kind: 'embedded', hash: key, ext: 'mp3' }, durationSec: byHash.get(key)!.durationSec },
      title: label.split(' – ')[1]!,
      artist: label.split(' – ')[0]!,
      label,
      fileName: `${label}.mp3`,
      addedAt: 0,
    };
  });
  const analyzer = fakeAnalyzer(byHash);
  setTrackAnalyzer(analyzer);
  library.setState({ songs, selected: [] });
  return { analyzer, prime: async (s: S) => analyzeFirst && Promise.all(songs.map((x) => analyzer.analyze(s, x.ref))) };
}

afterEach(() => {
  setTrackAnalyzer(null);
  library.setState({ songs: [], selected: [] });
});

describe('dj actions', () => {
  it('dj_mix mixes library songs by title in one undo step and the context lists the mix', async () => {
    const s = createTestServices();
    const { prime } = setup(true);
    await prime(s);
    const res = run(s, [{ op: 'dj_mix', songs: ['Lumen – Higher', 'midnight run'], energy: 'build' }]);
    expect(res.warnings).toEqual([]);
    expect(res.edited).toBe(true);
    const p = s.doc.getState().project;
    expect(p.dj!.songs.map((x) => x.title)).toEqual(['Lumen – Higher', 'Nova – Midnight Run']);
    expect(p.dj!.options).toMatchObject({ order: 'keep', energy: 'build' });
    expect(res.after).toContainEqual({ kind: 'mode', mode: 'song' });
    const ctx = projectContext(s);
    expect(ctx).toMatch(/DJ mix \(2 songs/);
    expect(ctx).toMatch(/1\. “Lumen – Higher”: 128 BPM, key 10A, Deck A, from bar 1/);
    expect(ctx).toMatch(/<music-library> \(3 songs\)/);
  });

  it('dj_transition changes one transition', async () => {
    const s = createTestServices();
    const { prime } = setup(true);
    await prime(s);
    run(s, [{ op: 'dj_mix', order: 'keep' }]);
    const res = run(s, [{ op: 'dj_transition', from_song: 2, to_song: 'Higher', length_bars: 32, recipe: 'filter', riser: true }]);
    expect(res.warnings).toEqual([]);
    expect(res.changes[0]).toMatch(/^Transition 2 \(“Kairo – Glass City” → “Lumen – Higher”\): 32 bars, filter with a riser/);
    const p = s.doc.getState().project;
    expect(Object.values(p.dj!.tweaks)).toEqual([{ bars: 32, recipe: 'filter', riser: true }]);
    const bad = run(s, [{ op: 'dj_transition', from_song: 1, to_song: 3, length_bars: 8 }]);
    expect(bad.warnings[0]).toMatch(/right after/);
  });

  it('analyzes songs after the answer when they are new', async () => {
    const s = createTestServices();
    const { analyzer } = setup(false);
    const res = run(s, [{ op: 'dj_mix' }]);
    const item = res.after.find((a) => a.kind === 'dj_mix')!;
    expect(item).toBeTruthy();
    expect(s.doc.getState().project.dj).toBeUndefined();
    const out = await djMixStep(item, { s, entry: null, signal: new AbortController().signal, progress: () => {}, whenQuiet: async () => {} });
    expect(analyzer.calls).toBe(3);
    expect(out!.message).toMatch(/3-song mix/);
    expect(s.doc.getState().project.dj!.songs).toHaveLength(3);
  });

  it('says streaming services can’t be mixed when the library is empty', () => {
    const s = createTestServices();
    const res = run(s, [{ op: 'dj_mix' }]);
    expect(res.warnings[0]).toMatch(/Spotify can’t be mixed/);
    expect(STUDIO_PROMPT).toMatch(/Spotify, Apple Music, YouTube/);
  });
});
