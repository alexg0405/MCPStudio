/**
 * The music library DJ mode mixes from: the musician's own song files (MP3, AAC/M4A, WAV, FLAC,
 * OGG), stored once by content in the sample store, with their title and artist from the tags (or
 * the file name), in the musician's order, kept in this browser (IndexedDB). Songs are analyzed in
 * the background, one at a time (`TrackAnalyzer`), so BPM, key and energy show up as they finish.
 * Streaming services can't be mixed: their audio is locked (DRM).
 */
import { createStore } from 'zustand/vanilla';
import { readTags, songTitle } from '@core/dj/tags';
import type { SampleRef } from '@core/model/types';
import { AUDIO_EXTENSIONS, listAudioFiles, pickDirectory, uploadFiles } from '@platform/fs-access';
import { idbGet, idbSet, isIdbAvailable } from '@platform/idb';
import { probeAudio } from '../actions/samples';
import { importSampleBytes } from '../persistence/sample-import';
import type { Services } from '../services';
import { peekAnalysis, sampleHash, trackAnalyzer } from './analyzer';
import type { MakeMixResult, MixSong } from './mix';
import type { DjMixOptions } from '@core/model/types';

export interface LibrarySong {
  /** Content hash (the song's identity). */
  key: string;
  ref: SampleRef;
  title: string;
  artist?: string;
  /** "Artist – Title". */
  label: string;
  fileName: string;
  durationSec?: number;
  addedAt: number;
  /** Auto order keeps it at its place in the list. */
  pinned?: boolean;
}

export type AnalysisStatus = { state: 'queued' } | { state: 'running'; fraction: number } | { state: 'error'; message: string };

export interface LibraryState {
  songs: LibrarySong[];
  loaded: boolean;
  /** Files being added: how many are done of how many. */
  adding: { done: number; total: number; name: string } | null;
  /** Songs not analyzed yet (absent = analyzed, or not looked at). */
  analysis: Record<string, AnalysisStatus>;
  /** Set when there is no analyzer in this build. */
  analyzerMissing: boolean;
  /** Selected songs (keys); none selected = the whole library goes in the mix. */
  selected: string[];
  /** A mix being made: what it is doing and how far. */
  making: { label: string; fraction: number } | null;
}

const KEY = 'dj-library';
/** At most this many files from one folder. */
export const MAX_FOLDER_FILES = 500;
/** Extensions the pickers offer (the browser decodes them). */
export const MUSIC_EXTENSIONS = [...AUDIO_EXTENSIONS, 'aac'] as const;

export const library = createStore<LibraryState>(() => ({
  songs: [],
  loaded: false,
  adding: null,
  analysis: {},
  analyzerMissing: false,
  selected: [],
  making: null,
}));

type Saved = Omit<LibrarySong, never>;

async function save(): Promise<void> {
  if (!isIdbAvailable()) return;
  await idbSet(KEY, library.getState().songs satisfies Saved[]).catch(() => {});
}

const isSong = (x: unknown): x is LibrarySong => {
  const o = x as LibrarySong;
  return !!o && typeof o.key === 'string' && typeof o.title === 'string' && typeof o.label === 'string' && !!o.ref && o.ref.source?.kind === 'embedded';
};

/** Reads the saved library (once). */
export async function loadLibrary(): Promise<void> {
  if (library.getState().loaded) return;
  let songs: LibrarySong[] = [];
  if (isIdbAvailable()) {
    try {
      const raw = await idbGet<unknown[]>(KEY);
      if (Array.isArray(raw)) songs = raw.filter(isSong);
    } catch {
      /* nothing saved */
    }
  }
  library.setState((st) => ({ songs: [...songs, ...st.songs.filter((x) => !songs.some((y) => y.key === x.key))], loaded: true }));
}

/** A song from a file's bytes (stored in the sample store), or null when it isn't audio the browser can read. */
export async function songFromBytes(bytes: Uint8Array, fileName: string): Promise<LibrarySong | null> {
  const facts = await probeAudio(bytes);
  if (!facts) return null;
  const ref = { ...(await importSampleBytes(bytes, fileName)), ...facts };
  const t = songTitle(readTags(bytes), fileName);
  return {
    key: sampleHash(ref)!,
    ref: { ...ref, name: t.label.slice(0, 128) },
    title: t.title,
    ...(t.artist ? { artist: t.artist } : {}),
    label: t.label,
    fileName,
    durationSec: facts.durationSec,
    addedAt: Date.now(),
  };
}

/** Adds songs (already-known files are skipped), saves, and starts analyzing. Returns how many were added. */
export async function addSongFiles(s: Services, files: readonly Pick<File, 'name' | 'arrayBuffer'>[]): Promise<number> {
  await loadLibrary();
  let added = 0;
  const failed: string[] = [];
  library.setState({ adding: { done: 0, total: files.length, name: files[0]?.name ?? '' } });
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      library.setState({ adding: { done: i, total: files.length, name: f.name } });
      try {
        const song = await songFromBytes(new Uint8Array(await f.arrayBuffer()), f.name);
        if (!song) {
          failed.push(f.name);
          continue;
        }
        if (library.getState().songs.some((x) => x.key === song.key)) continue;
        library.setState((st) => ({ songs: [...st.songs, song] }));
        added++;
      } catch {
        failed.push(f.name);
      }
    }
  } finally {
    library.setState({ adding: null });
  }
  await save();
  if (failed.length)
    s.session.getState().toast(`Couldn't read ${failed.length === 1 ? `“${failed[0]}”` : `${failed.length} files`}: not audio the browser can play.`, 'error');
  void analyzeLibrary(s);
  return added;
}

/** The file chooser (several files), then adds them. */
export async function pickSongFiles(s: Services): Promise<number> {
  const files = await uploadFiles(['audio/*', ...MUSIC_EXTENSIONS.map((e) => `.${e}`)].join(','));
  return files.length ? addSongFiles(s, files) : 0;
}

/** A folder chooser, then adds every audio file in it (and its subfolders). */
export async function pickSongFolder(s: Services): Promise<number> {
  const dir = await pickDirectory('music', 'read');
  if (!dir) return 0;
  const entries = (await listAudioFiles(dir, { recursive: true })).slice(0, MAX_FOLDER_FILES);
  const files = await Promise.all(entries.map(async (e) => e.handle.getFile()));
  return addSongFiles(s, files);
}

export async function removeSongs(keys: readonly string[]): Promise<void> {
  const drop = new Set(keys);
  library.setState((st) => ({ songs: st.songs.filter((x) => !drop.has(x.key)), selected: st.selected.filter((k) => !drop.has(k)) }));
  await save();
}

/** Moves a song to a position in the list (the order "Keep" mixes in). */
export async function moveSong(key: string, to: number): Promise<void> {
  library.setState((st) => {
    const songs = st.songs.slice();
    const from = songs.findIndex((x) => x.key === key);
    if (from < 0) return st;
    const [song] = songs.splice(from, 1);
    songs.splice(Math.max(0, Math.min(songs.length, to)), 0, song!);
    return { songs };
  });
  await save();
}

export async function togglePin(key: string): Promise<void> {
  library.setState((st) => ({ songs: st.songs.map((x) => (x.key === key ? { ...x, pinned: !x.pinned } : x)) }));
  await save();
}

export function setSelection(keys: readonly string[]): void {
  library.setState({ selected: [...new Set(keys)] });
}

/** What "Make the mix" mixes: the selected songs, else all of them (library order, pins kept). */
export function songsToMix(st: Pick<LibraryState, 'songs' | 'selected'>): LibrarySong[] {
  const sel = new Set(st.selected);
  return sel.size ? st.songs.filter((x) => sel.has(x.key)) : st.songs;
}

export const mixSongOf = (x: LibrarySong): MixSong => ({ ref: x.ref, title: x.label, ...(x.pinned ? { pinned: true } : {}) });

let running: Promise<void> | null = null;

/** Analyzes every song not analyzed yet, one at a time (one run at a time; new songs join it). */
export function analyzeLibrary(s: Services): Promise<void> {
  if (running) return running;
  const run: Promise<void> = (async () => {
    for (;;) {
      const analyzer = trackAnalyzer(s);
      library.setState({ analyzerMissing: !analyzer });
      if (!analyzer) return;
      const st = library.getState();
      const next = st.songs.find((x) => !analyzer.peek(x.key) && st.analysis[x.key]?.state !== 'error');
      if (!next) return;
      const set = (status: AnalysisStatus) => library.setState((cur) => ({ analysis: { ...cur.analysis, [next.key]: status } }));
      set({ state: 'running', fraction: 0 });
      try {
        await analyzer.analyze(s, next.ref, { onProgress: (p) => set({ state: 'running', fraction: p.fraction }) });
        library.setState((cur) => {
          const analysis = { ...cur.analysis };
          delete analysis[next.key];
          return { analysis };
        });
      } catch (e) {
        set({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }
  })().finally(() => {
    // Cleared here, not in the function above: a run with nothing to do (the DJ window opening with an
    // empty library) ends before `running` is assigned, which would leave it set for good.
    if (running === run) running = null;
  });
  running = run;
  return run;
}

let making: AbortController | null = null;

/** Makes the mix of these library songs (default: `songsToMix`), with progress in `making`. */
export async function makeLibraryMix(s: Services, options: DjMixOptions, songs?: readonly LibrarySong[], opts: { amend?: number } = {}): Promise<MakeMixResult | null> {
  if (making) return null;
  const list = songs ?? songsToMix(library.getState());
  if (list.length === 0) throw new Error('Add some songs to the library first.');
  making = new AbortController();
  library.setState({ making: { label: 'Getting the songs ready…', fraction: 0 } });
  try {
    // The mixer (ordering, beat-matching, transitions) loads when the first mix is made.
    const { makeMix } = await import('./mix');
    return await makeMix(s, list.map(mixSongOf), options, {
      signal: making.signal,
      ...(opts.amend !== undefined ? { amend: opts.amend } : {}),
      onProgress: (p) => library.setState({ making: { label: `Analyzing “${p.title}” (${p.index + 1} of ${p.count})`, fraction: (p.index + p.fraction) / p.count } }),
    });
  } finally {
    making = null;
    library.setState({ making: null });
  }
}

/** Stops a mix being made (while it analyzes). */
export function stopMaking(): void {
  making?.abort();
}

/** Library songs by name (exact label or title, then a unique partial match), for the Studio. */
export function findSongs(names: readonly string[]): { found: LibrarySong[]; missing: string[] } {
  const songs = library.getState().songs;
  const found: LibrarySong[] = [];
  const missing: string[] = [];
  for (const raw of names) {
    const t = raw.trim().toLowerCase();
    const exact = songs.filter((x) => x.label.toLowerCase() === t || x.title.toLowerCase() === t);
    const partial = exact.length ? exact : songs.filter((x) => x.label.toLowerCase().includes(t));
    if (partial.length >= 1 && !found.includes(partial[0]!)) found.push(partial[0]!);
    else if (!partial.length) missing.push(raw);
  }
  return { found, missing };
}

/** The music library for the Studio's context (titles, BPM and key when analyzed). */
export function musicLibraryLines(s: Services): string[] {
  const st = library.getState();
  if (!st.songs.length) return [];
  const lines = [`<music-library> (${st.songs.length} songs${st.selected.length ? `, ${st.selected.length} selected in the DJ window` : ''}):`];
  for (const [i, x] of st.songs.slice(0, 60).entries()) {
    const a = peekAnalysis(s, x.ref);
    const facts = a ? `${a.grid ? `${Math.round(a.grid.bpm * 10) / 10} BPM` : 'no steady beat'}, key ${a.key?.camelot ?? '?'}` : 'not analyzed yet';
    lines.push(`- ${i + 1}. “${x.label}”: ${facts}${st.selected.includes(x.key) ? ' (selected)' : ''}`);
  }
  if (st.songs.length > 60) lines.push(`… and ${st.songs.length - 60} more`);
  lines.push('</music-library>');
  return lines;
}
