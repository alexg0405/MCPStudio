import { createStore, type StoreApi } from 'zustand/vanilla';
import { PROJECT_FILE_EXTENSION, PROJECT_FILE_MIME, ProjectFileError } from '@core/io/project-file';
import type { Project } from '@core/model/types';
import {
  ensurePermission,
  isFileSystemAccessSupported,
  pickOpenFile,
  pickSaveFile,
  uploadFile,
} from '@platform/fs-access';
import { downloadParts, memorySink, openFileSink } from '@platform/sinks';
import { APP_VERSION } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { createDefaultProject } from './default-project';
import { buildProjectFile, openProjectBlob, writeProjectTo } from './persistence/project-io';
import { fileHandle, forgetFile, rememberFile } from './persistence/recent-files';
import { applyView, captureView } from './persistence/view-snapshot';
import type { Services } from './services';

/**
 * The open project's file: New, Open, Save, Save As and Open Recent. Saves overwrite the file the
 * project came from (File System Access) and fall back to a download where that API is missing.
 * "Unsaved changes" come from History's saved state, so undoing back to the saved state is clean.
 */
export interface FileState {
  /** Display name: the file name without its extension, or "Untitled". */
  name: string;
  /** Where Save writes. Null: Save asks where (or downloads, without File System Access). */
  handle: FileSystemFileHandle | null;
  /** IndexedDB key of `handle` (recent files, reload and crash recovery). */
  fileKey: string | null;
  busy: 'saving' | 'opening' | null;
}

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

/** Prompts and layout come from the UI layer (`ProjectFiles.setUi`). */
export interface FileUi {
  /** What to do with unsaved changes before the project is replaced. */
  askUnsaved(name: string): Promise<UnsavedChoice>;
  /** Arranges the default windows for a project that has no saved layout. */
  defaultLayout(): void;
}

export const UNTITLED = 'Untitled';

export function baseName(fileName: string): string {
  const name = fileName.replace(/\.agproj$/i, '').trim();
  return name || UNTITLED;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
/** Pickers need a recent user gesture; this is what an expired one throws. */
const isActivationError = (e: unknown) =>
  e instanceof DOMException && (e.name === 'SecurityError' || e.name === 'NotAllowedError');

export class ProjectFiles {
  readonly store: StoreApi<FileState> = createStore<FileState>()(() => ({
    name: UNTITLED,
    handle: null,
    fileKey: null,
    busy: null,
  }));

  private ui: FileUi = {
    askUnsaved: async (name) =>
      globalThis.confirm?.(`Discard unsaved changes to "${name}"?`) === true ? 'discard' : 'cancel',
    defaultLayout: () => {},
  };

  constructor(private readonly s: Services) {}

  setUi(ui: Partial<FileUi>): void {
    this.ui = { ...this.ui, ...ui };
  }

  get dirty(): boolean {
    return this.s.history.status().dirty;
  }

  /** Resolves true when the project may be replaced (nothing unsaved, saved now, or discarded). */
  async confirmReplace(): Promise<boolean> {
    if (!this.dirty) return true;
    const choice = await this.ui.askUnsaved(this.store.getState().name);
    if (choice === 'cancel') return false;
    if (choice === 'save') return this.save();
    return true;
  }

  /** A new, untitled project: the default template, or the given starting point. */
  async newProject(start?: Project): Promise<boolean> {
    if (!(await this.confirmReplace())) return false;
    this.replace(start ?? createDefaultProject(this.s.plugins), null, { name: UNTITLED, handle: null, fileKey: null });
    return true;
  }

  async open(): Promise<boolean> {
    if (!(await this.confirmReplace())) return false;
    try {
      if (isFileSystemAccessSupported()) {
        const handle = await pickOpenFile();
        return handle ? await this.openHandle(handle) : false;
      }
      const file = await uploadFile(PROJECT_FILE_EXTENSION);
      return file ? await this.openBlob(file, file.name, null, null) : false;
    } catch (e) {
      this.fail('open the project', e);
      return false;
    }
  }

  /** Opens a recently used file (asks for permission again when the browser needs it). */
  async openRecent(key: string): Promise<boolean> {
    const handle = await fileHandle(key);
    if (!handle) {
      await forgetFile(key);
      this.toast('That file is no longer available.', 'error');
      return false;
    }
    if (!(await this.confirmReplace())) return false;
    if (!(await ensurePermission(handle, 'readwrite', true)) && !(await ensurePermission(handle, 'read', true))) {
      this.toast(`No permission to open "${handle.name}".`, 'error');
      return false;
    }
    try {
      return await this.openHandle(handle);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'NotFoundError') {
        await forgetFile(key);
        this.toast(`"${handle.name}" was moved or deleted.`, 'error');
        return false;
      }
      this.fail('open the project', e);
      return false;
    }
  }

  /**
   * Opens a recently used file as a new, unsaved copy: its own identity (so its versions start fresh) and no file, so
   * Save asks where. The original is not touched.
   */
  async openRecentAsCopy(key: string): Promise<boolean> {
    const handle = await fileHandle(key);
    if (!handle) {
      await forgetFile(key);
      this.toast('That file is no longer available.', 'error');
      return false;
    }
    if (!(await this.confirmReplace())) return false;
    if (!(await ensurePermission(handle, 'read', true))) {
      this.toast(`No permission to open "${handle.name}".`, 'error');
      return false;
    }
    this.store.setState({ busy: 'opening' });
    try {
      const opened = await openProjectBlob(await handle.getFile());
      const name = `${baseName(handle.name)} (copy)`;
      const copy: Project = { ...opened.project, projectId: newId.project(), meta: { ...opened.project.meta, title: name } };
      this.replace(copy, opened.view, { name, handle: null, fileKey: null }, { dirty: true });
      return true;
    } catch (e) {
      this.fail(`open a copy of "${handle.name}"`, e);
      return false;
    } finally {
      this.store.setState({ busy: null });
    }
  }

  /** Opens a project file dropped on the window (or picked any other way). */
  async openFile(file: File, handle: FileSystemFileHandle | null = null): Promise<boolean> {
    if (!(await this.confirmReplace())) return false;
    try {
      const key = handle ? await rememberFile(handle) : null;
      return await this.openBlob(file, file.name, handle, key);
    } catch (e) {
      this.fail('open the project', e);
      return false;
    }
  }

  private async openHandle(handle: FileSystemFileHandle): Promise<boolean> {
    const file = await handle.getFile();
    const key = await rememberFile(handle);
    return this.openBlob(file, handle.name, handle, key);
  }

  /** Opens a project file read a piece at a time (big projects hold one embedded song at a time). */
  private async openBlob(
    blob: Blob,
    fileName: string,
    handle: FileSystemFileHandle | null,
    fileKey: string | null,
  ): Promise<boolean> {
    this.store.setState({ busy: 'opening' });
    try {
      const opened = await openProjectBlob(blob);
      const name = baseName(fileName);
      this.replace(opened.project, opened.view, { name, handle, fileKey });
      if (opened.migratedFrom < opened.project.schemaVersion)
        this.toast(`Upgraded "${name}" from an older AGstudio format.`);
      if (opened.repairs.length > 0) {
        console.warn(`Opened "${name}" with fixes:\n- ${opened.repairs.join('\n- ')}`);
        this.toast(
          opened.repairs.length === 1
            ? (opened.repairs[0] as string)
            : `Opened "${name}" with ${opened.repairs.length} fixes (details in the console).`,
          'error',
        );
      }
      return true;
    } catch (e) {
      this.fail(`open "${fileName}"`, e);
      return false;
    } finally {
      this.store.setState({ busy: null });
    }
  }

  /**
   * Replaces the open project (open, new, recover). The new document starts with empty undo history;
   * `dirty` marks work that exists in no file yet.
   */
  replace(
    project: Project,
    view: unknown,
    file: Pick<FileState, 'name' | 'handle' | 'fileKey'>,
    opts: { dirty?: boolean } = {},
  ): void {
    this.s.engine.stop();
    this.s.history.load(project, opts);
    if (!applyView(this.s, view, project)) this.ui.defaultLayout();
    this.store.setState({ name: file.name, handle: file.handle, fileKey: file.fileKey });
  }

  /** Saves to the project's file, or asks where when it has none. */
  async save(): Promise<boolean> {
    const { handle } = this.store.getState();
    if (!handle) return this.saveAs();
    if (!(await ensurePermission(handle, 'readwrite', true))) {
      this.toast(`No permission to write "${handle.name}". Choose where to save it.`, 'error');
      return this.saveAs();
    }
    return this.writeTo(handle);
  }

  async saveAs(): Promise<boolean> {
    const suggested = `${this.store.getState().name}${PROJECT_FILE_EXTENSION}`;
    if (!isFileSystemAccessSupported()) return this.download(suggested);
    let handle: FileSystemFileHandle | null;
    try {
      handle = await pickSaveFile(suggested);
    } catch (e) {
      if (isAbort(e)) return false;
      if (isActivationError(e)) {
        this.toast('Saving needs a click or key press: choose Save as… again.', 'error');
        return false;
      }
      this.fail('save the project', e);
      return false;
    }
    if (!handle) return false;
    if (!(await this.writeTo(handle))) return false;
    const fileKey = await rememberFile(handle);
    this.store.setState({ handle, fileKey, name: baseName(handle.name) });
    return true;
  }

  /** The project as a complete .agproj (embedded samples included). */
  async build(): Promise<Uint8Array> {
    let missing = 0;
    const bytes = await buildProjectFile(this.s.doc.getState().project, captureView(this.s), APP_VERSION, {
      onMissingSamples: (refs) => (missing = refs.length),
    });
    if (missing > 0)
      this.toast(`${missing} sample${missing === 1 ? ' is' : 's are'} missing and weren't saved with the project.`);
    return bytes;
  }

  /**
   * Writes the project file into `write` a piece at a time: embedded samples are read from the
   * sample store one by one as they are written, so a project with hundreds of MB of songs never
   * sits in memory whole.
   */
  private async writeStream(write: (bytes: Uint8Array) => Promise<void>): Promise<void> {
    let missing = 0;
    await writeProjectTo(write, this.s.doc.getState().project, captureView(this.s), APP_VERSION, {
      onMissingSamples: (refs) => (missing = refs.length),
    });
    if (missing > 0)
      this.toast(`${missing} sample${missing === 1 ? ' is' : 's are'} missing and weren't saved with the project.`);
  }

  private async writeTo(handle: FileSystemFileHandle): Promise<boolean> {
    this.store.setState({ busy: 'saving' });
    try {
      // What gets written is the state at this point; edits made while saving stay unsaved.
      const cursor = this.s.history.checkpoint();
      // createWritable swaps the file in on close: a failed save leaves the old file.
      const sink = await openFileSink(handle);
      try {
        await this.writeStream((b) => sink.write(b));
        await sink.close();
      } catch (e) {
        await sink.abort();
        throw e;
      }
      this.s.history.markSaved(cursor);
      this.saved(handle.name);
      return true;
    } catch (e) {
      this.fail(`save "${handle.name}"`, e);
      return false;
    } finally {
      this.store.setState({ busy: null });
    }
  }

  private async download(fileName: string): Promise<boolean> {
    this.store.setState({ busy: 'saving' });
    try {
      const cursor = this.s.history.checkpoint();
      const sink = memorySink();
      await this.writeStream((b) => sink.write(b));
      downloadParts(fileName, sink.parts(), PROJECT_FILE_MIME);
      this.s.history.markSaved(cursor);
      this.store.setState({ name: baseName(fileName) });
      this.saved(fileName);
      return true;
    } catch (e) {
      this.fail('save the project', e);
      return false;
    } finally {
      this.store.setState({ busy: null });
    }
  }

  private savedListeners = new Set<() => void>();

  /** Fires after every successful save (autosave uses it to mark its copy clean). */
  onSaved(fn: () => void): () => void {
    this.savedListeners.add(fn);
    return () => this.savedListeners.delete(fn);
  }

  private saved(fileName: string): void {
    this.toast(`Saved "${fileName}"`);
    for (const fn of this.savedListeners) fn();
  }

  private toast(text: string, kind?: 'error'): void {
    this.s.session.getState().toast(text, kind);
  }

  private fail(what: string, e: unknown): void {
    if (isAbort(e)) return;
    console.error(`Could not ${what}`, e);
    const reason = e instanceof ProjectFileError || e instanceof Error ? e.message : String(e);
    this.toast(`Could not ${what}: ${reason}`, 'error');
  }
}
