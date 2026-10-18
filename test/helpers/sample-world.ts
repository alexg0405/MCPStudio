/**
 * Test services with a sample folder of in-memory WAV files, analyzed (no Workers, no IndexedDB): for the sample browser's
 * app and AI tests. Pass sounds from `sample-corpus.ts`.
 */
import { createStore } from 'zustand/vanilla';
import { encodeWav } from '@core/io/wav';
import { createTestServices } from '@app/testing';
import type { FolderLike } from '@app/samples/browser';
import { inlineRunner } from '@app/samples/runner';
import { memoryBrowserStorage } from '@app/samples/storage';

export const SAMPLE_RATE = 44100;

export interface FakeFile {
  path: string;
  file: File;
}

/** A 16-bit mono WAV file in memory at `path` (the folder part is its path inside the folder). */
export function wavFile(x: Float32Array, path: string, lastModified = 1_700_000_000_000): FakeFile {
  return {
    path,
    file: new File([encodeWav([x], SAMPLE_RATE, { bitDepth: 16 }).slice().buffer], path.split('/').pop() as string, { lastModified }),
  };
}

export async function sampleWorld(files: FakeFile[], opts: { folder?: string } = {}) {
  const folder: FolderLike = {
    key: 'dir_test',
    name: opts.folder ?? 'Pack',
    access: 'granted',
    files: files.map((f) => ({ name: f.file.name, path: f.path, handle: { getFile: () => Promise.resolve(f.file) } })),
  };
  const folders = createStore<{ folders: readonly FolderLike[] }>(() => ({ folders: files.length ? [folder] : [] }));
  const s = createTestServices({ sampleBrowser: { storage: memoryBrowserStorage(), folders, runner: () => inlineRunner(async () => null), flushMs: 5 } });
  s.sampleBrowser.start();
  await s.sampleBrowser.whenIdle();
  return { s, folders, row: (name: string) => s.sampleBrowser.find(name)! };
}
