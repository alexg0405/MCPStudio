import type { VersionFileInfo, VersionFileStore } from '@platform/opfs';

/** Version files in memory (tests, and the app when the browser has no private file system). */
export function memoryVersionFiles(): VersionFileStore & { files: Map<string, { bytes: Uint8Array; modifiedAt: number }> } {
  const files = new Map<string, { bytes: Uint8Array; modifiedAt: number }>();
  const keyOf = (projectId: string, versionId: string) => `${projectId}/${versionId}`;
  return {
    files,
    async write(projectId, versionId, bytes) {
      files.set(keyOf(projectId, versionId), { bytes: bytes.slice(), modifiedAt: Date.now() });
    },
    async read(projectId, versionId) {
      return files.get(keyOf(projectId, versionId))?.bytes.slice() ?? null;
    },
    async remove(projectId, versionId) {
      files.delete(keyOf(projectId, versionId));
    },
    async list() {
      const list: VersionFileInfo[] = [];
      for (const [key, file] of files) {
        const [projectId, versionId] = key.split('/') as [string, string];
        list.push({ projectId, versionId, size: file.bytes.byteLength, modifiedAt: file.modifiedAt });
      }
      return list;
    },
  };
}
