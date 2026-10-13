import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadBytes,
  ensurePermission,
  isAudioFileName,
  isFileSystemAccessSupported,
  listAudioFiles,
  pickDirectory,
  pickOpenFile,
  pickSaveFile,
  readFile,
  uploadFile,
  writeFile,
} from './fs-access';

const TEST_ROOT = 'agstudio-test-fs';
let dir: FileSystemDirectoryHandle;

beforeEach(async () => {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(TEST_ROOT, { recursive: true }).catch(() => {});
  dir = await root.getDirectoryHandle(TEST_ROOT, { create: true });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await (await navigator.storage.getDirectory()).removeEntry(TEST_ROOT, { recursive: true }).catch(() => {});
});

async function touch(parent: FileSystemDirectoryHandle, path: string): Promise<void> {
  const parts = path.split('/');
  let d = parent;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  await d.getFileHandle(parts[parts.length - 1]!, { create: true });
}

const abort = () => new DOMException('The user aborted a request.', 'AbortError');

describe('listAudioFiles', () => {
  beforeEach(async () => {
    for (const p of [
      'kick 10.wav',
      'kick 2.WAV',
      'Pad.aiff',
      'readme.txt',
      '.hidden.wav',
      'loops/drums.flac',
      'loops/deeper/vox.m4a',
      'loops/deeper/notes.md',
      '.git/objects.wav',
    ]) {
      await touch(dir, p);
    }
  });

  it('lists audio files in natural order, top level only by default', async () => {
    const files = await listAudioFiles(dir);
    expect(files.map((f) => f.path)).toEqual(['kick 2.WAV', 'kick 10.wav', 'Pad.aiff']);
    expect(files[0]!.handle.kind).toBe('file');
    expect(files[0]!.name).toBe('kick 2.WAV');
  });

  it('descends into subfolders when recursive', async () => {
    const files = await listAudioFiles(dir, { recursive: true });
    expect(files.map((f) => f.path)).toEqual([
      'kick 2.WAV',
      'kick 10.wav',
      'loops/deeper/vox.m4a',
      'loops/drums.flac',
      'Pad.aiff',
    ]);
  });

  it('can be aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(listAudioFiles(dir, { recursive: true, signal: ctrl.signal })).rejects.toThrow();
  });

  it('recognizes the supported extensions', () => {
    for (const n of ['a.wav', 'a.aiff', 'a.aif', 'a.flac', 'a.mp3', 'a.ogg', 'a.opus', 'a.M4A'])
      expect(isAudioFileName(n)).toBe(true);
    for (const n of ['a.mid', 'a.wav.txt', 'wav', 'a.agproj']) expect(isAudioFileName(n)).toBe(false);
  });
});

describe('readFile / writeFile', () => {
  it('round-trips bytes and replaces the whole file', async () => {
    const handle = await dir.getFileHandle('song.agproj', { create: true });
    await writeFile(handle, Uint8Array.from([1, 2, 3, 4, 5]));
    expect(await readFile(handle)).toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
    await writeFile(handle, Uint8Array.from([9]));
    expect(await readFile(handle)).toEqual(Uint8Array.from([9]));
    const shared = new Uint8Array(new SharedArrayBuffer(2));
    shared.set([7, 8]);
    await writeFile(handle, shared);
    expect(await readFile(handle)).toEqual(Uint8Array.from([7, 8]));
  });
});

describe('ensurePermission', () => {
  it('is granted for handles the origin owns', async () => {
    expect(await ensurePermission(dir, 'readwrite', false)).toBe(true);
  });

  it('asks only when allowed to', async () => {
    const requestPermission = vi.fn(async () => 'granted' as PermissionState);
    const handle = { queryPermission: async () => 'prompt' as PermissionState, requestPermission };
    expect(await ensurePermission(handle as unknown as FileSystemHandle, 'read', false)).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(await ensurePermission(handle as unknown as FileSystemHandle, 'read', true)).toBe(true);
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'read' });
  });

  it('treats denial and errors as no permission, and missing APIs as granted', async () => {
    const denied = { queryPermission: async () => 'prompt', requestPermission: async () => 'denied' };
    expect(await ensurePermission(denied as unknown as FileSystemHandle, 'readwrite', true)).toBe(false);
    const throws = {
      queryPermission: async () => 'prompt',
      requestPermission: async () => {
        throw new DOMException('User activation is required', 'SecurityError');
      },
    };
    expect(await ensurePermission(throws as unknown as FileSystemHandle, 'readwrite', true)).toBe(false);
    expect(await ensurePermission({} as FileSystemHandle, 'readwrite', true)).toBe(true);
  });
});

describe('pickers', () => {
  it('reports support as a boolean', () => {
    expect(typeof isFileSystemAccessSupported()).toBe('boolean');
  });

  it('suggests a .agproj name and returns the chosen handle', async () => {
    const handle = await dir.getFileHandle('x.agproj', { create: true });
    const showSaveFilePicker = vi.fn(async () => handle);
    vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);
    expect(await pickSaveFile('My Song')).toBe(handle);
    expect(await pickSaveFile('Beat.AGPROJ')).toBe(handle);
    expect(showSaveFilePicker.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      expect.objectContaining({
        suggestedName: 'My Song.agproj',
        id: 'agproj',
        types: [{ description: 'AGstudio project', accept: { 'application/x-agstudio-project': ['.agproj'] } }],
      }),
      expect.objectContaining({ suggestedName: 'Beat.AGPROJ' }),
    ]);
  });

  it('returns null when the user cancels and rethrows other errors', async () => {
    vi.stubGlobal('showSaveFilePicker', async () => {
      throw abort();
    });
    vi.stubGlobal('showOpenFilePicker', async () => {
      throw abort();
    });
    vi.stubGlobal('showDirectoryPicker', async () => {
      throw abort();
    });
    expect(await pickSaveFile('x')).toBeNull();
    expect(await pickOpenFile()).toBeNull();
    expect(await pickDirectory('samples')).toBeNull();
    vi.stubGlobal('showOpenFilePicker', async () => {
      throw new DOMException('Must be handling a user gesture', 'SecurityError');
    });
    await expect(pickOpenFile()).rejects.toThrow('user gesture');
  });

  it('opens one project file and picks folders with an id and mode', async () => {
    const file = await dir.getFileHandle('a.agproj', { create: true });
    const showOpenFilePicker = vi.fn(async () => [file]);
    const showDirectoryPicker = vi.fn(async () => dir);
    vi.stubGlobal('showOpenFilePicker', showOpenFilePicker);
    vi.stubGlobal('showDirectoryPicker', showDirectoryPicker);
    expect(await pickOpenFile()).toBe(file);
    expect(showOpenFilePicker).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, id: 'agproj' }));
    expect(await pickDirectory('samples')).toBe(dir);
    expect(showDirectoryPicker).toHaveBeenCalledWith({ id: 'samples', mode: 'read' });
  });
});

describe('fallbacks', () => {
  it('downloads bytes through an object URL', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadBytes('song.agproj', Uint8Array.from([1, 2, 3]), 'application/x-agstudio-project');
    expect(click).toHaveBeenCalledTimes(1);
    const a = click.mock.contexts[0] as HTMLAnchorElement | undefined;
    expect(a?.download).toBe('song.agproj');
    expect(a?.isConnected).toBe(false); // cleaned up
    const res = await fetch(a!.href);
    expect(res.headers.get('content-type')).toBe('application/x-agstudio-project');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('resolves the chosen file, or null on cancel', async () => {
    const file = new File(['abc'], 'song.agproj');
    let accept = '';
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      accept = this.accept;
      const dt = new DataTransfer();
      dt.items.add(file);
      this.files = dt.files;
      this.dispatchEvent(new Event('change'));
    });
    const got = await uploadFile('.agproj');
    expect(accept).toBe('.agproj');
    expect(got?.name).toBe('song.agproj');
    expect(await got?.text()).toBe('abc');

    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      this.dispatchEvent(new Event('cancel'));
    });
    expect(await uploadFile('audio/*')).toBeNull();
    expect(document.querySelectorAll('input[type=file]')).toHaveLength(0);
  });
});
