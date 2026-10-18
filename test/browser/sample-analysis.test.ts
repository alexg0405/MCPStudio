/**
 * The sample analysis in real Chrome with real Workers: a folder of 1500 short WAV files (synthetic one-shots) analyzed by
 * the Worker pool (files per second), the same results as on the main thread, FLAC read in the Worker, MP3 decoded by the
 * browser and analyzed in the Worker, and a folder going through the model with the Worker pool and the cache.
 */
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { encodeFlac } from '@core/io/flac';
import { encodeWav } from '@core/io/wav';
import { SAMPLE_CATEGORIES } from '@core/samples/types';
import { SampleBrowser, type FolderLike } from '@app/samples/browser';
import { analysisWorkerCount, inlineRunner, workerPoolRunner, type AnalysisRunner } from '@app/samples/runner';
import { memoryBrowserStorage } from '@app/samples/storage';
import { encodeMp3 } from '@app/export/mp3';
import { engineCorpus, handmadeCorpus, SR } from '../helpers/sample-corpus';
import { perfLimit } from '../helpers/perf';

const corpus = [...engineCorpus().filter((s) => s.clear), ...handmadeCorpus(10).filter((s) => s.clear)];
const wav = (x: Float32Array, i: number) => new File([encodeWav([x], SR, { bitDepth: 16 }).slice().buffer], `s${i}.wav`, { lastModified: 1_700_000_000_000 + i });

describe('sample analysis in Workers', { timeout: 300_000 }, () => {
  it('analyzes 1500 short files with the Worker pool: speed, and the same answers as the main thread', async () => {
    const N = 1500;
    const files = Array.from({ length: N }, (_, i) => wav(corpus[i % corpus.length]!.x, i));
    const pool = workerPoolRunner(analysisWorkerCount());
    try {
      // Warm up: the Workers load their code.
      await Promise.all(files.slice(0, analysisWorkerCount() * 2).map((f, i) => pool.run(f, `w${i}.wav`)));
      const t0 = performance.now();
      const results = await Promise.all(files.map((f, i) => pool.run(f, `s${i}.wav`)));
      const sec = (performance.now() - t0) / 1000;
      const rate = N / sec;
      console.info(`sample analysis: ${N} files in ${sec.toFixed(2)} s = ${rate.toFixed(0)} files/s on ${analysisWorkerCount()} Workers`);
      expect(results.every((r) => r !== null)).toBe(true);
      // Accuracy on the clear sounds the files were made from.
      let right = 0;
      results.forEach((r, i) => {
        if (r?.category === corpus[i % corpus.length]!.label) right++;
      });
      expect(right / N).toBeGreaterThanOrEqual(0.9);
      // The Worker answers what the main thread answers.
      const inline = inlineRunner(async () => null);
      for (let i = 0; i < 40; i++) expect(results[i], corpus[i % corpus.length]!.name).toEqual(await inline.run(files[i]!, `s${i}.wav`));
      expect(rate).toBeGreaterThanOrEqual(perfLimit(300, 60));
    } finally {
      pool.dispose();
    }
  });

  it('reads FLAC in the Worker and MP3 through the browser decoder, and says null for what is not audio', async () => {
    const kick = corpus.find((s) => s.name === 'kit/kick')!;
    const note = corpus.find((s) => s.label === 'tonal' && s.midi !== undefined)!;
    const hat = corpus.find((s) => s.name === 'kit/hat-closed')!;
    const flac = new File([encodeFlac([kick.x], SR, { bitDepth: 16 }).slice().buffer], 'Kick.flac');
    const mp3 = new File([encodeMp3([note.x], SR, 192).slice().buffer], 'Note.mp3');
    const mp3Hat = new File([encodeMp3([hat.x], SR, 192).slice().buffer], 'Hat.mp3');
    const junk = new File([new Uint8Array(300).fill(7)], 'junk.wav');
    const pool = workerPoolRunner(2);
    try {
      const [a, b, c, d] = await Promise.all([pool.run(flac, 'Kick.flac'), pool.run(mp3, 'Note.mp3'), pool.run(mp3Hat, 'Hat.mp3'), pool.run(junk, 'junk.wav')]);
      expect(a?.category).toBe('kick');
      expect(b?.category).toBe('tonal');
      expect(Math.abs((b?.midi ?? 0) - (note.midi as number))).toBeLessThan(0.6);
      expect(c?.category).toBe('hat');
      expect(d).toBeNull();
      // FLAC through the Worker equals the same file through the main thread.
      expect(a).toEqual(await inlineRunner(async () => null).run(flac, 'Kick.flac'));
    } finally {
      pool.dispose();
    }
  });

  it('a folder through the model with Workers: analyzed once, then from the cache without any analysis', async () => {
    const files = corpus.slice(0, 60).map((s, i) => ({ name: `s${i}.wav`, path: `Kits/${s.name.replace(/[^\w]+/g, '_')}.wav`, file: wav(s.x, i) }));
    const folder: FolderLike = { key: 'dir_w', name: 'W', access: 'granted', files: files.map((f) => ({ name: f.name, path: f.path, handle: { getFile: () => Promise.resolve(f.file) } })) };
    const storage = memoryBrowserStorage();
    let runs = 0;
    const make = () => {
      const pool = workerPoolRunner(2);
      const counted: AnalysisRunner = {
        run: (file, path) => {
          runs++;
          return pool.run(file, path);
        },
        dispose: () => pool.dispose(),
      };
      return new SampleBrowser({ storage, folders: createStore<{ folders: readonly FolderLike[] }>(() => ({ folders: [folder] })), runner: () => counted, flushMs: 20, saveMs: 50 });
    };
    const first = make();
    first.start();
    await first.whenIdle();
    expect(runs).toBe(60);
    expect(first.store.getState().rows.filter((r) => r.analysis).length).toBe(60);
    expect(first.store.getState().progress.filesPerSec).toBeGreaterThan(0);
    first.stop();
    runs = 0;
    const second = make();
    second.start();
    await second.whenIdle();
    expect(runs).toBe(0);
    expect(second.store.getState().rows.every((r) => r.analysis !== null)).toBe(true);
    second.stop();
    expect(SAMPLE_CATEGORIES.length).toBeGreaterThan(5);
  });
});
