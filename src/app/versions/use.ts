import type { StoreApi } from 'zustand/vanilla';
import { newId } from '@core/model/ids';
import type { Project } from '@core/model/types';
import { restoreProject } from '@core/ops/restore';
import { describeProjectChanges, type ProjectChanges } from '@core/versions/diff';
import { versionTitle, type SavePointReason, type VersionRecord } from '@core/versions/types';
import { findMissingSamples, missingSoundsNotice } from '../persistence/project-io';
import type { Services } from '../services';
import { renderVersionPreview } from './preview';
import { VersionError, type LoadedVersion, type VersionStore } from './store';
import type { VersionsView } from './view-state';

/**
 * Using a version: what changed since it, restoring it, opening it as a copy and listening to it. The service decides when
 * versions are made; this is what is done with one once it exists.
 */

/** A name for a copy is cut at this many characters. */
const MAX_COPY_NAME_LENGTH = 120;
/** A preview's mark (the Stop button) stays this long past the preview's own length (ms), for the engine to finish. */
const PREVIEW_MARK_SLACK_MS = 600;

/** What `VersionUse` needs from the service around it. */
export interface VersionUseDeps {
  s: Services;
  store: VersionStore;
  view: StoreApi<VersionsView>;
  /** Keeps the project as it is as a version (resolves with it, or null when there was nothing new). */
  savePoint(reason: SavePointReason, note?: string): Promise<VersionRecord | null>;
  /** Resolves when every queued write is on disk. */
  settled(): Promise<void>;
  /** A project's versions, newest first. */
  versionsOf(projectId: string): Promise<VersionRecord[]>;
}

export class VersionUse {
  constructor(private readonly d: VersionUseDeps) {}

  private get project(): Project {
    return this.d.s.doc.getState().project;
  }

  private toast(text: string, kind?: 'error'): void {
    this.d.s.session.getState().toast(text, kind);
  }

  /** Reads a version; when it cannot be read, says why in a toast and returns null. */
  private async readOrExplain(record: VersionRecord): Promise<LoadedVersion | null> {
    try {
      return await this.d.store.read(record);
    } catch (error) {
      this.toast(error instanceof VersionError ? error.message : 'This version cannot be read.', 'error');
      return null;
    }
  }

  /** Marks a version as busy for as long as `work` runs (its buttons wait). */
  private async whileBusy<T>(record: VersionRecord, work: () => Promise<T>): Promise<T> {
    this.d.view.setState({ busyId: record.id });
    try {
      return await work();
    } finally {
      this.d.view.setState({ busyId: null });
    }
  }

  /** What changed in the open project since a version: the sentences "what is different" shows. */
  async changesSince(record: VersionRecord): Promise<ProjectChanges> {
    const loaded = await this.readOrExplain(record);
    if (!loaded) return { parts: [], lines: [] };
    return describeProjectChanges(loaded.project, this.project, (id) => this.d.s.automation.pluginInfo(id));
  }

  /**
   * Puts the open project back to a version, as one undo step. The project as it is now is kept as a version first, so
   * even a restore that is later regretted past the undo history loses nothing.
   */
  async restore(record: VersionRecord): Promise<boolean> {
    if (record.projectId !== this.project.projectId) {
      this.toast('That version belongs to another project. Open it as a copy, or open that project first.', 'error');
      return false;
    }
    return this.whileBusy(record, async () => {
      const loaded = await this.readOrExplain(record);
      if (!loaded) return false;
      await this.d.savePoint('before-restore', `restoring “${versionTitle(record)}”`);
      await this.d.settled();
      const base = this.project;
      const title = versionTitle(record);
      const changed = this.d.s.history.transact(`Restore version “${title}”`, (draft) => restoreProject(draft, base, loaded.project));
      this.toast(changed ? `Restored “${title}”. Undo brings back what you had.` : 'The project already matches that version.');
      await this.noteMissingSounds(loaded.project);
      return changed;
    });
  }

  /** Opens a version as a new, unsaved project, so the open one is untouched (unsaved changes are asked about first). */
  openAsCopy(record: VersionRecord): Promise<boolean> {
    return this.whileBusy(record, async () => {
      const loaded = await this.readOrExplain(record);
      if (!loaded) return false;
      if (!(await this.d.s.files.confirmReplace())) return false;
      const name = `${record.title || 'Untitled'} (${versionTitle(record)})`.slice(0, MAX_COPY_NAME_LENGTH);
      const copy: Project = { ...loaded.project, projectId: newId.project(), meta: { ...loaded.project.meta, title: name } };
      this.d.s.files.replace(copy, loaded.view, { name, handle: null, fileKey: null }, { dirty: true });
      await this.noteMissingSounds(copy);
      return true;
    });
  }

  /**
   * Opens a project's newest version as the open project, keeping its identity, so its history carries on
   * (for a project that has versions and no file).
   */
  async openLatestOf(projectId: string, name: string): Promise<boolean> {
    const latest = (await this.d.versionsOf(projectId))[0];
    if (!latest) {
      this.toast('That project has no versions to open.', 'error');
      return false;
    }
    const loaded = await this.readOrExplain(latest);
    if (!loaded) return false;
    if (!(await this.d.s.files.confirmReplace())) return false;
    this.d.s.files.replace(loaded.project, loaded.view, { name, handle: null, fileKey: null }, { dirty: true });
    await this.noteMissingSounds(loaded.project);
    return true;
  }

  /** Tells the musician which sounds a project just opened or restored cannot find. */
  private async noteMissingSounds(project: Project): Promise<void> {
    const notice = missingSoundsNotice(await findMissingSamples(project).catch(() => []));
    if (notice) this.toast(notice, 'error');
  }

  /** Renders the start of a version and plays it, leaving the open project alone. Asking again stops it. */
  async preview(record: VersionRecord): Promise<void> {
    if (this.d.view.getState().previewingId === record.id) return this.stopPreview();
    await this.whileBusy(record, async () => {
      try {
        const loaded = await this.readOrExplain(record);
        if (!loaded) return;
        this.d.s.engine.stop();
        const rendered = await renderVersionPreview(this.d.s, loaded.project);
        if (!rendered) {
          this.toast('That version has nothing to play yet (no clips and no patterns).');
          return;
        }
        await this.d.s.engine.resume();
        const isPlaying = await this.d.s.engine.previewAudio(rendered.wav.slice().buffer as ArrayBuffer);
        this.d.view.setState({ previewingId: isPlaying ? record.id : null });
        if (isPlaying) setTimeout(() => this.clearPreviewMark(record.id), rendered.seconds * 1000 + PREVIEW_MARK_SLACK_MS);
      } catch (error) {
        console.warn('Could not preview the version:', error);
        this.toast('Could not play that version.', 'error');
      }
    });
  }

  private clearPreviewMark(id: string): void {
    if (this.d.view.getState().previewingId === id) this.d.view.setState({ previewingId: null });
  }

  /** Stops a version's preview. */
  stopPreview(): void {
    this.d.s.engine.stopPreview();
    this.d.view.setState({ previewingId: null });
  }
}
