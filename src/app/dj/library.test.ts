import { afterEach, describe, expect, it } from 'vitest';
import { fakeAnalysis } from '@core/dj/fake-analysis';
import type { TrackAnalysis } from '@core/dj/types';
import { createTestServices } from '../testing';
import { fakeAnalyzer, setTrackAnalyzer } from './analyzer';
import { analyzeLibrary, library, type LibrarySong } from './library';

const hashOf = (n: number) => String(n).padStart(64, '0');
const song = (n: number): LibrarySong => ({
  key: hashOf(n),
  ref: { id: `smp_${n}` as never, name: `Song ${n}`, source: { kind: 'embedded', hash: hashOf(n), ext: 'mp3' } },
  title: `Song ${n}`,
  label: `Song ${n}`,
  fileName: `${n}.mp3`,
  addedAt: n,
});

afterEach(() => {
  setTrackAnalyzer(null);
  library.setState({ songs: [], analysis: {}, selected: [] });
});

describe('analyzing the library', () => {
  it('analyzes songs added after an earlier run found nothing to do (opening the DJ window with an empty library)', async () => {
    const byHash = new Map<string, TrackAnalysis>([1, 2].map((n) => [hashOf(n), fakeAnalysis({ bpm: 120 + n, hash: hashOf(n) })]));
    const analyzer = fakeAnalyzer(byHash);
    setTrackAnalyzer(analyzer);
    const s = createTestServices();
    // The DJ window calls this when it opens, whatever the library holds.
    await analyzeLibrary(s);
    expect(analyzer.calls).toBe(0);
    // Then the musician adds songs, which starts analysis again.
    library.setState({ songs: [song(1), song(2)] });
    await analyzeLibrary(s);
    expect(analyzer.calls).toBe(2);
    expect(analyzer.peek(hashOf(1))?.grid?.bpm).toBe(121);
    expect(analyzer.peek(hashOf(2))?.grid?.bpm).toBe(122);
  });

  it('shares one run between callers and can run again afterwards', async () => {
    const byHash = new Map<string, TrackAnalysis>([1, 2, 3].map((n) => [hashOf(n), fakeAnalysis({ bpm: 120, hash: hashOf(n) })]));
    const analyzer = fakeAnalyzer(byHash);
    setTrackAnalyzer(analyzer);
    const s = createTestServices();
    library.setState({ songs: [song(1)] });
    const a = analyzeLibrary(s);
    expect(analyzeLibrary(s)).toBe(a);
    await a;
    library.setState({ songs: [song(1), song(2), song(3)] });
    await analyzeLibrary(s);
    expect(analyzer.calls).toBe(3);
  });

  it('says so when there is no analyzer, and recovers when one appears', async () => {
    const s = createTestServices() as unknown as Parameters<typeof analyzeLibrary>[0];
    delete (s as unknown as { trackAnalyzer?: unknown }).trackAnalyzer;
    library.setState({ songs: [song(1)] });
    await analyzeLibrary(s);
    expect(library.getState().analyzerMissing).toBe(true);
    const analyzer = fakeAnalyzer(new Map([[hashOf(1), fakeAnalysis({ bpm: 120, hash: hashOf(1) })]]));
    setTrackAnalyzer(analyzer);
    await analyzeLibrary(s);
    expect(library.getState().analyzerMissing).toBe(false);
    expect(analyzer.calls).toBe(1);
  });
});
