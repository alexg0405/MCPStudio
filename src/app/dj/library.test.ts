import { afterEach, describe, expect, it } from 'vitest';
import { fakeAnalysis } from '@core/dj/fake-analysis';
import type { TrackAnalysis } from '@core/dj/types';
import { encodeWav } from '@core/io/wav';
import { newId } from '@core/model/ids';
import { relinkMissingSamples } from '../actions/flp-import';
import { createMemoryBlobStore } from '../persistence/blob-store';
import { createTestServices } from '../testing';
import { fakeAnalyzer, setTrackAnalyzer } from './analyzer';
import { analyzeLibrary, library, type LibrarySong } from './library';
import { makeMix } from './mix';

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

describe('finding the samples of a DJ mix again', () => {
  it('keeps the mix pointing at the song when its audio is found (File > Find missing samples)', async () => {
    const specs = [
      { name: 'Alpha', bpm: 124 },
      { name: 'Bravo', bpm: 126 },
    ];
    const byHash = new Map<string, TrackAnalysis>();
    const list = specs.map((sp, i) => {
      const hash = hashOf(100 + i);
      const analysis = fakeAnalysis({ bpm: sp.bpm, hash, bars: 64 });
      byHash.set(hash, analysis);
      return {
        ref: { id: newId.sample(), name: sp.name, source: { kind: 'embedded' as const, hash, ext: 'wav' }, durationSec: analysis.durationSec, channels: 2 },
        title: sp.name,
      };
    });
    setTrackAnalyzer(fakeAnalyzer(byHash));
    const s = createTestServices();
    await makeMix(s, list, { order: 'keep', energy: 'party', transition: 'auto', mixTempo: 'follow' });
    expect(s.doc.getState().project.dj!.songs).toHaveLength(2);
    const store = createMemoryBlobStore();
    const wav = encodeWav([new Float32Array(4800).fill(0.1)], 48000, { bitDepth: 16 });
    const res = await relinkMissingSamples(s, [{ name: 'Alpha.wav', arrayBuffer: async () => wav.slice().buffer }], { store });
    expect(res.found).toEqual(['Alpha']);
    const after = s.doc.getState().project;
    for (const song of after.dj!.songs) expect(after.samples[song.sampleId], song.title).toBeDefined();
    expect(after.dj!.songs.map((x) => x.title)).toEqual(['Alpha', 'Bravo']);
    expect(Object.keys(after.dj!.tweaks).every((id) => after.samples[id as never])).toBe(true);
  });
});
