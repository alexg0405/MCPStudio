/**
 * File System Access helpers (Chromium: showSaveFilePicker & co.) with fallbacks for browsers that
 * lack them: `downloadBytes` (an <a download> link) and `uploadFile` (a hidden <input type=file>).
 * Pickers need a user gesture (transient activation lasts about 5 s), so call them first in a
 * command handler, before any slow work.
 */
import { unsharedBytes } from '@core/io/bytes';
import { PROJECT_FILE_EXTENSION, PROJECT_FILE_MIME } from '@core/io/project-file';

// Not in TypeScript's DOM lib (WICG File System Access).
interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string | string[]>;
}

interface FilePickerOptions {
  id?: string;
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
  startIn?: string | FileSystemHandle;
}

interface PickerWindow {
  showSaveFilePicker?(options?: FilePickerOptions & { suggestedName?: string }): Promise<FileSystemFileHandle>;
  showOpenFilePicker?(options?: FilePickerOptions & { multiple?: boolean }): Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?(options?: {
    id?: string;
    mode?: PermissionMode;
    startIn?: string;
  }): Promise<FileSystemDirectoryHandle>;
}

type PermissionMode = 'read' | 'readwrite';

interface PermissionedHandle {
  queryPermission?(descriptor: { mode: PermissionMode }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: PermissionMode }): Promise<PermissionState>;
}

export const AUDIO_EXTENSIONS = ['wav', 'aiff', 'aif', 'flac', 'mp3', 'ogg', 'opus', 'm4a'] as const;
const AUDIO_FILE = new RegExp(`\\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i');

const PROJECT_TYPES: FilePickerAcceptType[] = [
  { description: 'AGstudio project', accept: { [PROJECT_FILE_MIME]: [PROJECT_FILE_EXTENSION] } },
];
/** Shared picker id: Chrome remembers the last folder per id. */
const PROJECT_PICKER_ID = 'agproj';

const pickers = () => globalThis as unknown as PickerWindow;
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** True when the save/open/directory pickers exist (Chromium desktop, secure context). */
export function isFileSystemAccessSupported(): boolean {
  const w = pickers();
  return (
    typeof w.showSaveFilePicker === 'function' &&
    typeof w.showOpenFilePicker === 'function' &&
    typeof w.showDirectoryPicker === 'function'
  );
}

export function isAudioFileName(name: string): boolean {
  return AUDIO_FILE.test(name);
}

function requirePicker<K extends keyof PickerWindow>(name: K): NonNullable<PickerWindow[K]> {
  const fn = pickers()[name];
  if (typeof fn !== 'function') throw new Error(`${name} is not supported in this browser.`);
  return fn.bind(globalThis) as NonNullable<PickerWindow[K]>;
}

/** Asks where to save a project. Resolves null when the user cancels. */
export async function pickSaveFile(suggestedName: string): Promise<FileSystemFileHandle | null> {
  const name = suggestedName.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
    ? suggestedName
    : `${suggestedName}${PROJECT_FILE_EXTENSION}`;
  try {
    return await requirePicker('showSaveFilePicker')({
      suggestedName: name,
      types: PROJECT_TYPES,
      id: PROJECT_PICKER_ID,
    });
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** Audio export file kinds: what the save picker offers, by extension. */
const AUDIO_TYPES: Record<string, FilePickerAcceptType> = {
  wav: { description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } },
  flac: { description: 'FLAC audio (lossless, smaller)', accept: { 'audio/flac': ['.flac'] } },
  mp3: { description: 'MP3 audio', accept: { 'audio/mpeg': ['.mp3'] } },
  zip: { description: 'Zip archive', accept: { 'application/zip': ['.zip'] } },
  mp4: { description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } },
  webm: { description: 'WebM video', accept: { 'video/webm': ['.webm'] } },
};

/**
 * Asks where to save an exported file of a kind ('wav', 'flac', 'mp3', 'zip'). Resolves null when
 * the user cancels.
 */
export async function pickSaveExportFile(suggestedName: string, ext: string): Promise<FileSystemFileHandle | null> {
  const name = suggestedName.toLowerCase().endsWith(`.${ext}`) ? suggestedName : `${suggestedName}.${ext}`;
  const type = AUDIO_TYPES[ext];
  try {
    return await requirePicker('showSaveFilePicker')({ suggestedName: name, types: type ? [type] : [], id: 'export' });
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** Writes (creating or replacing) a file inside a folder the user picked. */
export async function writeFileInDirectory(
  dir: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  await writeFile(handle, bytes);
}

const MIDI_TYPES: FilePickerAcceptType[] = [{ description: 'MIDI file', accept: { 'audio/midi': ['.mid'] } }];

/** Asks where to save an exported MIDI file. Resolves null when the user cancels. */
export async function pickSaveMidiFile(suggestedName: string): Promise<FileSystemFileHandle | null> {
  const name = /\.midi?$/i.test(suggestedName) ? suggestedName : `${suggestedName}.mid`;
  try {
    return await requirePicker('showSaveFilePicker')({ suggestedName: name, types: MIDI_TYPES, id: 'export' });
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** Asks for a project file to open. Resolves null when the user cancels. */
export async function pickOpenFile(): Promise<FileSystemFileHandle | null> {
  try {
    const [handle] = await requirePicker('showOpenFilePicker')({
      types: PROJECT_TYPES,
      id: PROJECT_PICKER_ID,
      multiple: false,
    });
    return handle ?? null;
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** Asks for a folder (e.g. a sample library, `id: 'samples'`). Resolves null when the user cancels. */
export async function pickDirectory(
  id: string,
  mode: PermissionMode = 'read',
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await requirePicker('showDirectoryPicker')({ id, mode });
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/**
 * Whether we may use the handle in `mode`. With `request`, asks the user when the permission is in
 * the "prompt" state (needs a user gesture; handles restored from IndexedDB start there). Browsers
 * without the permission API grant access to handles they give out.
 */
export async function ensurePermission(
  handle: FileSystemHandle,
  mode: PermissionMode,
  request: boolean,
): Promise<boolean> {
  const h = handle as FileSystemHandle & PermissionedHandle;
  if (typeof h.queryPermission !== 'function') return true;
  try {
    if ((await h.queryPermission({ mode })) === 'granted') return true;
    if (!request || typeof h.requestPermission !== 'function') return false;
    return (await h.requestPermission({ mode })) === 'granted';
  } catch {
    return false; // e.g. SecurityError: requestPermission without a user gesture
  }
}

/** Replaces the file's contents atomically (the browser swaps the new data in on close). */
export async function writeFile(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(unsharedBytes(bytes));
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
}

export async function readFile(handle: FileSystemFileHandle): Promise<Uint8Array> {
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

export interface AudioFileEntry {
  name: string;
  /** Path relative to the listed directory, '/'-separated. */
  path: string;
  handle: FileSystemFileHandle;
}

/**
 * Audio files (by extension: wav, aif(f), flac, mp3, ogg, opus, m4a) in a directory, sorted by path.
 * Hidden entries (dot names) are skipped.
 */
export async function listAudioFiles(
  dir: FileSystemDirectoryHandle,
  opts: { recursive?: boolean; signal?: AbortSignal } = {},
): Promise<AudioFileEntry[]> {
  const out: AudioFileEntry[] = [];
  const walk = async (d: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> => {
    for await (const [name, handle] of d.entries()) {
      opts.signal?.throwIfAborted();
      if (name.startsWith('.')) continue;
      if (handle.kind === 'file') {
        if (isAudioFileName(name)) out.push({ name, path: prefix + name, handle });
      } else if (opts.recursive && depth < 32) {
        await walk(handle, `${prefix}${name}/`, depth + 1);
      }
    }
  };
  await walk(dir, '', 0);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return out.sort((a, b) => collator.compare(a.path, b.path));
}

/** Fallback save: downloads the bytes through a temporary object URL. */
export function downloadBytes(name: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([unsharedBytes(bytes)], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Revoking right away can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** Like uploadFile, for several files at once (empty when cancelled). */
export function uploadFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.style.display = 'none';
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

/**
 * Fallback open: shows the browser's file chooser through a hidden <input type=file>. Resolves null
 * when the user cancels. `accept` is the input's accept attribute (e.g. ".agproj" or "audio/*").
 */
export function uploadFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}
