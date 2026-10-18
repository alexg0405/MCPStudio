import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { encodeWav } from '@core/io/wav';
import { SAMPLE_ANALYSIS_VERSION } from '@core/samples/types';
import { chord, MINOR, PATTERNS, renderTestSong } from '@core/dj/test-songs';
import { engineCorpus, handmadeCorpus } from '../../../test/helpers/sample-corpus';
import { SampleBrowser, type FolderLike } from './browser';
import { inlineRunner, type AnalysisRunner } from './runner';
import { memoryBrowserStorage } from './storage';

const SR = 44100;

function wav(x: Float32Array, name: string, lastModified = 1_700_000_000_000): { name: string; file: File } {
  const bytes = encodeWav([x], SR, { bitDepth: 16 });
  return { name, file: new File([bytes as BlobPart], name.split('/').pop() as string, { lastModified }) };
}

const sounds = [...engineCorpus().filter((s) => s.clear), ...handmadeCorpus(2)];
const pick = (label: string, n = 0) => sounds.filter((s) => s.label === label)[n]!;

type Fake = { name: string; file: File };
const entries = (files: Fake[]) => files.map((f) => ({ name: f.name.split('/').pop() as string, path: f.name, handle: { getFile: () => Promise.resolve(f.file) } }));

function setup(files: Fake[], opts: { storage?: ReturnType<typeof memoryBrowserStorage>; key?: string; name?: string } = {}) {
  const key = opts.key ?? 'dir_a';
  const folder: FolderLike = { key, name: opts.name ?? 'Pack', access: 'granted', files: entries(files) };
  const folders = createStore<{ folders: readonly FolderLike[] }>(() => ({ folders: [folder] }));
  const storage = opts.storage ?? memoryBrowserStorage();
  let runs = 0;
  const inner = inlineRunner(async () => null);
  const runner: AnalysisRunner = {
    run: (file, path) => {
      runs++;
      return inner.run(file, path);
    },
    dispose: () => inner.dispose(),
  };
  const browser = new SampleBrowser({ storage, folders, runner: () => runner, flushMs: 5, saveMs: 20, identityBatch: 4 });
  return { browser, folders, storage, runs: () => runs, folder };
}

const basicFiles = (): Fake[] => [
  wav(pick('kick').x, 'Kicks/Kick A.wav'),
  wav(pick('snare').x, 'Snares/Snare A.wav'),
  wav(pick('hat').x, 'Hats/Hat A.wav'),
  wav(pick('808').x, '808/Bass A.wav'),
  wav(pick('tonal').x, 'Keys/Note A.wav'),
];

describe('sample browser model', () => {
  it('lists every file, analyzes them in the background and saves the folder cache', async () => {
    const t = setup(basicFiles());
    t.browser.start();
    await t.browser.whenIdle();
    const rows = t.browser.store.getState().rows;
    expect(rows.map((r) => r.path)).toEqual(['Kicks/Kick A.wav', 'Snares/Snare A.wav', 'Hats/Hat A.wav', '808/Bass A.wav', 'Keys/Note A.wav']);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName['Kick A']!.analysis?.category).toBe('kick');
    expect(byName['Snare A']!.analysis?.category).toBe('snare');
    expect(byName['Hat A']!.analysis?.category).toBe('hat');
    expect(byName['Bass A']!.analysis?.category).toBe('808');
    expect(byName['Note A']!.analysis?.category).toBe('tonal');
    expect(rows.every((r) => r.state === 'ready')).toBe(true);
    expect(t.runs()).toBe(5);
    const p = t.browser.store.getState().progress;
    expect(p).toMatchObject({ total: 5, done: 5, failed: 0, running: false });
    const record = t.storage.records.get('dir_a')!;
    expect(Object.keys(record.files)).toHaveLength(5);
    expect(record.version).toBe(SAMPLE_ANALYSIS_VERSION);
    t.browser.stop();
  });

  it('uses the cache when the folder comes back unchanged: nothing is analyzed again', async () => {
    const files = basicFiles();
    const first = setup(files);
    first.browser.start();
    await first.browser.whenIdle();
    first.browser.stop();
    const second = setup(files, { storage: first.storage });
    second.browser.start();
    // The cached analyses are in the rows at once (before the files are even checked).
    await new Promise((r) => setTimeout(r, 0));
    await second.browser.whenIdle();
    expect(second.runs()).toBe(0);
    expect(second.browser.store.getState().rows.every((r) => r.analysis !== null && r.state === 'ready')).toBe(true);
    expect(second.browser.store.getState().progress.total).toBe(0);
    second.browser.stop();
  });

  it('analyzes again only the file that changed (size or time), and one that is new', async () => {
    const files = basicFiles();
    const first = setup(files);
    first.browser.start();
    await first.browser.whenIdle();
    first.browser.stop();
    const changed = files.map((f, i) => (i === 1 ? wav(pick('snare', 1).x, f.name, 1_800_000_000_000) : f));
    changed.push(wav(pick('clap').x, 'Claps/Clap A.wav'));
    const second = setup(changed, { storage: first.storage });
    second.browser.start();
    await second.browser.whenIdle();
    expect(second.runs()).toBe(2);
    const record = second.storage.records.get('dir_a')!;
    expect(Object.keys(record.files)).toHaveLength(6);
    second.browser.stop();
  });

  it('analyzes everything again when the analyzer version changed', async () => {
    const files = basicFiles();
    const first = setup(files);
    first.browser.start();
    await first.browser.whenIdle();
    first.browser.stop();
    // The stored cache was made by an older analyzer.
    const old = first.storage.records.get('dir_a')!;
    first.storage.records.set('dir_a', { ...old, version: SAMPLE_ANALYSIS_VERSION - 1 });
    const second = setup(files, { storage: first.storage });
    second.browser.start();
    await second.browser.whenIdle();
    expect(second.runs()).toBe(5);
    expect(first.storage.records.get('dir_a')!.version).toBe(SAMPLE_ANALYSIS_VERSION);
    second.browser.stop();
  });

  it('forgets a removed file in the cache and drops a removed folder with its cache', async () => {
    const files = basicFiles();
    const t = setup(files);
    t.browser.start();
    await t.browser.whenIdle();
    t.folders.setState({ folders: [{ ...t.folder, files: entries(files.slice(0, 3)) }] });
    await t.browser.whenIdle();
    expect(t.browser.store.getState().rows).toHaveLength(3);
    expect(Object.keys(t.storage.records.get('dir_a')!.files)).toHaveLength(3);
    t.folders.setState({ folders: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(t.browser.store.getState().rows).toHaveLength(0);
    expect(t.storage.records.has('dir_a')).toBe(false);
    t.browser.stop();
  });

  it('marks a file that is not audio as failed, and keeps going', async () => {
    const files = [...basicFiles(), { name: 'Junk/broken.wav', file: new File([new Uint8Array(500)], 'broken.wav') }];
    const t = setup(files);
    t.browser.start();
    await t.browser.whenIdle();
    const rows = t.browser.store.getState().rows;
    expect(rows.find((r) => r.name === 'broken')!.state).toBe('failed');
    expect(rows.filter((r) => r.state === 'ready')).toHaveLength(5);
    expect(t.browser.store.getState().progress.failed).toBe(1);
    // A failure is not cached (the file may be fixed), a success is.
    expect(Object.keys(t.storage.records.get('dir_a')!.files)).toHaveLength(5);
    t.browser.stop();
  });

  it('puts results into the rows in batches, not one update per file', async () => {
    const many: Fake[] = [];
    for (let i = 0; i < 120; i++) many.push(wav(sounds[i % 12]!.x, `Pack/s${String(i).padStart(3, '0')}.wav`, 1_700_000_000_000 + i));
    const t = setup(many);
    let updates = 0;
    t.browser.store.subscribe(() => updates++);
    t.browser.start();
    await t.browser.whenIdle();
    expect(t.browser.store.getState().rows.filter((r) => r.analysis).length).toBe(120);
    expect(updates).toBeLessThan(120);
    t.browser.stop();
  });

  it('analyzes loops with their tempo and bars', async () => {
    const song = renderTestSong({ sampleRate: SR, bpm: 128, pattern: PATTERNS.house, parts: [{ bars: 2, kick: true, snare: true, hats: true }], tail: 0, chords: [chord(57, MINOR)] });
    const t = setup([wav(song.mono, 'Loops/Drum Loop.wav')]);
    t.browser.start();
    await t.browser.whenIdle();
    const a = t.browser.store.getState().rows[0]!.analysis!;
    expect(a.kind).toBe('loop');
    expect(a.bpm).toBeCloseTo(128, 0);
    expect(a.bars).toBe(2);
    t.browser.stop();
  });
});

/** A WAV with a `smpl` chunk that says the sound is tuned to `note`. */
function wavWithRoot(x: Float32Array, note: number): File {
  const bytes = encodeWav([x], SR, { bitDepth: 16 });
  const smpl = new Uint8Array(8 + 36);
  const v = new DataView(smpl.buffer);
  smpl.set([0x73, 0x6d, 0x70, 0x6c]);
  v.setUint32(4, 36, true);
  v.setUint32(8 + 12, note, true);
  const out = new Uint8Array(bytes.length + smpl.length);
  out.set(bytes);
  out.set(smpl, bytes.length);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return new File([out as BlobPart], 'Pad.wav', { lastModified: 1_700_000_000_000 });
}

describe('sample browser: notes the file declares', () => {
  it('takes the note from the file`s sampler chunk over the pitch it measures, for pitched sounds', async () => {
    const note = pick('tonal');
    const file = wavWithRoot(note.x, 50); // D3, whatever the audio is
    const t = setup([{ name: 'Keys/Pad.wav', file }]);
    t.browser.start();
    await t.browser.whenIdle();
    const a = t.browser.store.getState().rows[0]!.analysis!;
    expect(a.category).toBe('tonal');
    expect(a.midi).toBe(50);
    expect(a.root).toBe(2);
    expect(a.keyConfidence).toBe(0.95);
    // A hat has no note to declare.
    const hat = setup([{ name: 'Hats/Hat.wav', file: wavWithRoot(pick('hat').x, 50) }]);
    hat.browser.start();
    await hat.browser.whenIdle();
    expect(hat.browser.store.getState().rows[0]!.analysis!.midi).toBeUndefined();
    t.browser.stop();
    hat.browser.stop();
  });
});

describe('sample browser: your marks on files', () => {
  it('keeps favorites, your tags and recently used sounds, and brings them back with the folder', async () => {
    const files = basicFiles();
    const a = setup(files);
    a.browser.start();
    await a.browser.whenIdle();
    const kick = a.browser.find('Kick A')!;
    a.browser.toggleFavorite(kick.id);
    expect(a.browser.addTag(kick.id, '  Punchy ')).toBe(true);
    expect(a.browser.addTag(kick.id, 'punchy')).toBe(false);
    expect(a.browser.addTag(kick.id, '   ')).toBe(false);
    a.browser.markUsed([kick.id]);
    let row = a.browser.rowById(kick.id)!;
    expect(row.favorite).toBe(true);
    expect(row.userTags).toEqual(['punchy']);
    expect(row.lastUsed).toBeGreaterThan(0);
    expect(a.browser.allTags()).toEqual([{ tag: 'punchy', count: 1 }]);
    await new Promise((r) => setTimeout(r, 10));
    a.browser.stop();
    const b = setup(files, { storage: a.storage });
    b.browser.start();
    await b.browser.whenIdle();
    row = b.browser.find('Kick A')!;
    expect(row.favorite).toBe(true);
    expect(row.userTags).toEqual(['punchy']);
    expect(row.lastUsed).toBeGreaterThan(0);
    b.browser.removeTag(row.id, 'punchy');
    b.browser.toggleFavorite(row.id, false);
    row = b.browser.rowById(row.id)!;
    expect(row.favorite).toBe(false);
    expect(row.userTags).toEqual([]);
    b.browser.stop();
  });

  it('keeps only the most recent 300 sounds used', async () => {
    const t = setup(basicFiles());
    t.browser.start();
    await t.browser.whenIdle();
    const ids = Array.from({ length: 320 }, (_, i) => `x:${i}`);
    t.browser.markUsed(ids);
    await new Promise((r) => setTimeout(r, 5));
    expect(Object.keys(t.storage.user.lastUsed)).toHaveLength(300);
    t.browser.stop();
  });

  it('finds a row by id, path, path without extension or name', async () => {
    const t = setup(basicFiles());
    t.browser.start();
    await t.browser.whenIdle();
    const id = t.browser.store.getState().rows.find((r) => r.name === 'Hat A')!.id;
    for (const q of [id, 'Pack/Hats/Hat A.wav', 'Hats/Hat A.wav', 'hats/hat a', 'Hat A', 'hat a']) expect(t.browser.find(q)?.id, q).toBe(id);
    expect(t.browser.find('nothing like it')).toBeUndefined();
    expect(t.browser.find('  ')).toBeUndefined();
    t.browser.stop();
  });

  it('shows the filtered, sorted rows and keeps the same list while nothing changed', async () => {
    const t = setup(basicFiles());
    t.browser.start();
    await t.browser.whenIdle();
    t.browser.setFilter({ categories: ['kick', 'snare'] });
    const a = t.browser.visibleRows();
    expect(a.map((r) => r.name)).toEqual(['Kick A', 'Snare A']);
    expect(t.browser.visibleRows()).toBe(a);
    // The same column again turns it round; another column starts ascending.
    t.browser.setSort('name');
    expect(t.browser.store.getState().descending).toBe(true);
    expect(t.browser.visibleRows().map((r) => r.name)).toEqual(['Snare A', 'Kick A']);
    t.browser.setSort('length');
    expect(t.browser.store.getState().descending).toBe(false);
    t.browser.setSort('name', false);
    t.browser.clearFilter();
    expect(t.browser.visibleRows()).toHaveLength(5);
    t.browser.stop();
  });
});
