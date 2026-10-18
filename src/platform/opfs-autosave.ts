/**
 * Autosaves in OPFS: `autosave/<sessionId>/a.agproj` and `b.agproj` (each with a `.json` meta file beside it).
 *
 * An autosave slot is valid when its data matches the size and hash recorded in its meta file. The data is
 * written first and the meta that vouches for it second, and the writer alternates slots, so an interrupted
 * save leaves the previous slot intact.
 */
import { isSha256Hex, sha256Hex } from '@core/io/hash';
import {
  assertSessionId,
  ensureDir,
  fileOf,
  getDir,
  guard,
  isNotFound,
  isSessionId,
  readBytes,
  writeFile,
} from './opfs-files';
import {
  StorageError,
  type AutosaveFile,
  type AutosaveMeta,
  type AutosaveSlot,
  type AutosaveStore,
  type RootDirectory,
} from './opfs-types';

const AUTOSAVE_DIRECTORY = 'autosave';
const SLOTS: readonly AutosaveSlot[] = ['a', 'b'];
/** The version of the slot meta file's layout. */
const SLOT_RECORD_VERSION = 1;

/** What the slot meta file holds: the caller's meta plus what makes the slot verifiable. */
interface SlotRecord extends AutosaveMeta {
  v: typeof SLOT_RECORD_VERSION;
  size: number;
  sha256: string;
}

const dataFileName = (slot: AutosaveSlot) => `${slot}.agproj`;
const metaFileName = (slot: AutosaveSlot) => `${slot}.json`;
const encodeRecord = (record: SlotRecord) => new TextEncoder().encode(JSON.stringify(record));

function parseSlotRecord(bytes: Uint8Array | null, slot: AutosaveSlot): SlotRecord | null {
  if (!bytes) return null;
  try {
    const r = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SlotRecord>;
    const isValid =
      r.v === SLOT_RECORD_VERSION &&
      r.slot === slot &&
      typeof r.sessionId === 'string' &&
      typeof r.projectId === 'string' &&
      typeof r.title === 'string' &&
      typeof r.savedAt === 'string' &&
      typeof r.clean === 'boolean' &&
      (r.fileKey === undefined || typeof r.fileKey === 'string') &&
      typeof r.size === 'number' &&
      isSha256Hex(r.sha256);
    return isValid ? (r as SlotRecord) : null;
  } catch {
    return null;
  }
}

function toMeta(record: SlotRecord, sessionId: string): AutosaveMeta {
  const meta: AutosaveMeta = {
    sessionId,
    projectId: record.projectId,
    title: record.title,
    savedAt: record.savedAt,
    clean: record.clean,
    slot: record.slot,
  };
  if (record.fileKey !== undefined) meta.fileKey = record.fileKey;
  return meta;
}

const savedAtMs = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? -Infinity : ms;
};
const newestFirst = (a: { savedAt: string }, b: { savedAt: string }) => savedAtMs(b.savedAt) - savedAtMs(a.savedAt);

/** Creates the autosave store; nothing touches the browser until a method is called. */
export function createAutosaveStorage(
  root: RootDirectory,
): AutosaveStore & { autosaveFiles(): Promise<AutosaveFile[]> } {
  async function slotRecords(dir: FileSystemDirectoryHandle): Promise<SlotRecord[]> {
    const records: SlotRecord[] = [];
    for (const slot of SLOTS) {
      const record = parseSlotRecord(await readBytes(dir, metaFileName(slot)), slot);
      if (record) records.push(record);
    }
    return records.sort(newestFirst);
  }

  /**
   * The newest slot whose data matches the size and SHA-256 its meta records. listAutosaves,
   * readAutosave and markAutosaveClean all use this one rule (autosaves are thin, so hashing is cheap).
   */
  async function newestValid(dir: FileSystemDirectoryHandle): Promise<{ record: SlotRecord; data: Uint8Array } | null> {
    for (const record of await slotRecords(dir)) {
      const data = await readBytes(dir, dataFileName(record.slot));
      if (data && data.byteLength === record.size && (await sha256Hex(data)) === record.sha256) return { record, data };
    }
    return null;
  }

  async function sessionDir(sessionId: string): Promise<FileSystemDirectoryHandle | null> {
    assertSessionId(sessionId);
    const autosave = await getDir(await root(), AUTOSAVE_DIRECTORY);
    return autosave ? getDir(autosave, sessionId) : null;
  }

  return {
    autosaveFiles: () =>
      guard('list autosaves', async () => {
        const autosave = await getDir(await root(), AUTOSAVE_DIRECTORY);
        if (!autosave) return [];
        const files: AutosaveFile[] = [];
        for await (const [name, handle] of autosave.entries()) {
          if (handle.kind !== 'directory' || !isSessionId(name)) continue;
          for (const slot of SLOTS) {
            try {
              const file = await fileOf(handle as FileSystemDirectoryHandle, dataFileName(slot));
              if (!file) continue;
              files.push({
                sessionId: name,
                slot,
                size: file.size,
                read: async () => new Uint8Array(await file.arrayBuffer()),
              });
            } catch (e) {
              if (!isNotFound(e)) throw e;
            }
          }
        }
        return files;
      }),

    writeAutosave: (sessionId, slot, data, meta) =>
      guard('autosave the project', async () => {
        if (!SLOTS.includes(slot)) throw new StorageError('invalid', `"${String(slot)}" is not an autosave slot.`);
        assertSessionId(sessionId);
        const dir = await ensureDir(await ensureDir(await root(), AUTOSAVE_DIRECTORY), sessionId);
        const record: SlotRecord = {
          sessionId,
          projectId: meta.projectId,
          title: meta.title,
          savedAt: meta.savedAt,
          clean: meta.clean,
          slot,
          ...(meta.fileKey === undefined ? {} : { fileKey: meta.fileKey }),
          v: SLOT_RECORD_VERSION,
          size: data.byteLength,
          sha256: await sha256Hex(data),
        };
        // Data first, then the meta that vouches for it: an interrupted save leaves this slot invalid
        // and the other slot (the previous save) intact.
        await writeFile(dir, dataFileName(slot), data);
        await writeFile(dir, metaFileName(slot), encodeRecord(record));
      }),

    readAutosave: (sessionId) =>
      guard('read an autosave', async () => {
        const dir = await sessionDir(sessionId);
        const valid = dir ? await newestValid(dir) : null;
        return valid ? { data: valid.data, meta: toMeta(valid.record, sessionId) } : null;
      }),

    listAutosaves: () =>
      guard('list autosaves', async () => {
        const autosave = await getDir(await root(), AUTOSAVE_DIRECTORY);
        if (!autosave) return [];
        const metas: AutosaveMeta[] = [];
        for await (const [name, handle] of autosave.entries()) {
          if (handle.kind !== 'directory' || !isSessionId(name)) continue;
          try {
            const valid = await newestValid(handle);
            if (valid) metas.push(toMeta(valid.record, name));
          } catch {
            // A session deleted or half-written by another tab while we looked: skip it.
          }
        }
        return metas.sort(newestFirst);
      }),

    deleteAutosave: (sessionId) =>
      guard('delete an autosave', async () => {
        assertSessionId(sessionId);
        const autosave = await getDir(await root(), AUTOSAVE_DIRECTORY);
        if (!autosave) return;
        try {
          await autosave.removeEntry(sessionId, { recursive: true });
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
      }),

    markAutosaveClean: (sessionId) =>
      guard('update an autosave', async () => {
        const dir = await sessionDir(sessionId);
        const record = dir ? (await newestValid(dir))?.record : undefined;
        if (!dir || !record || record.clean) return;
        await writeFile(dir, metaFileName(record.slot), encodeRecord({ ...record, clean: true }));
      }),
  };
}
