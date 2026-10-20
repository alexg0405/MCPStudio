/**
 * Version files in OPFS: `versions/<projectId>/<versionId>.agver`, each a thin project file (the project and its view,
 * compressed; no sample bytes, those stay in the blob store). Writes go through createWritable(), which swaps the file in
 * on close, so an interrupted write never leaves half a version. What a version is called, when it was made and which
 * samples it needs lives in IndexedDB (`app/versions`); this file only keeps the bytes.
 */
import { assertSessionId, ensureDir, fileOf, getDir, guard, isNotFound, isSessionId, writeFile } from './opfs-files';
import type { RootDirectory } from './opfs-types';

const VERSIONS_DIRECTORY = 'versions';
const EXTENSION = '.agver';

/** One stored version file, as listing shows it. */
export interface VersionFileInfo {
  projectId: string;
  versionId: string;
  /** Bytes. */
  size: number;
  /** When the file was last written (ms since 1970). */
  modifiedAt: number;
}

/** Where version files are kept: OPFS in the app, memory in tests. */
export interface VersionFileStore {
  write(projectId: string, versionId: string, bytes: Uint8Array): Promise<void>;
  /** The file's bytes, or null when there is none. */
  read(projectId: string, versionId: string): Promise<Uint8Array | null>;
  remove(projectId: string, versionId: string): Promise<void>;
  /** Every version file of every project. */
  list(): Promise<VersionFileInfo[]>;
}

const fileName = (versionId: string) => `${versionId}${EXTENSION}`;

/** Creates the OPFS-backed store; nothing touches the browser until a method is called. */
export function createVersionFiles(root: RootDirectory): VersionFileStore {
  async function projectDir(projectId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    assertSessionId(projectId);
    const top = create ? await ensureDir(await root(), VERSIONS_DIRECTORY) : await getDir(await root(), VERSIONS_DIRECTORY);
    if (!top) return null;
    return create ? ensureDir(top, projectId) : getDir(top, projectId);
  }

  return {
    write: (projectId, versionId, bytes) =>
      guard('save a version', async () => {
        assertSessionId(versionId);
        const dir = await projectDir(projectId, true);
        await writeFile(dir as FileSystemDirectoryHandle, fileName(versionId), bytes);
      }),

    read: (projectId, versionId) =>
      guard('read a version', async () => {
        assertSessionId(versionId);
        const dir = await projectDir(projectId, false);
        const file = dir ? await fileOf(dir, fileName(versionId)) : null;
        return file ? new Uint8Array(await file.arrayBuffer()) : null;
      }),

    remove: (projectId, versionId) =>
      guard('delete a version', async () => {
        assertSessionId(versionId);
        const dir = await projectDir(projectId, false);
        if (!dir) return;
        try {
          await dir.removeEntry(fileName(versionId));
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
        // An empty folder of a project with no versions left is removed too.
        let isEmpty = true;
        for await (const _ of dir.entries()) {
          isEmpty = false;
          break;
        }
        if (!isEmpty) return;
        const top = await getDir(await root(), VERSIONS_DIRECTORY);
        await top?.removeEntry(projectId).catch(() => {});
      }),

    list: () =>
      guard('list versions', async () => {
        const top = await getDir(await root(), VERSIONS_DIRECTORY);
        if (!top) return [];
        const files: VersionFileInfo[] = [];
        for await (const [projectId, folder] of top.entries()) {
          if (folder.kind !== 'directory' || !isSessionId(projectId)) continue;
          for await (const [name, handle] of (folder as FileSystemDirectoryHandle).entries()) {
            if (handle.kind !== 'file' || !name.endsWith(EXTENSION)) continue;
            const versionId = name.slice(0, -EXTENSION.length);
            if (!isSessionId(versionId)) continue;
            try {
              const file = await (handle as FileSystemFileHandle).getFile();
              files.push({ projectId, versionId, size: file.size, modifiedAt: file.lastModified });
            } catch (e) {
              if (!isNotFound(e)) throw e; // deleted while we looked
            }
          }
        }
        return files;
      }),
  };
}
