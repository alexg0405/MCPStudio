import type { StoreApi } from 'zustand/vanilla';
import type { DocChange } from '@core/history/history';
import type { Project } from '@core/model/types';
import type { ProjectChanges } from '@core/versions/diff';
import { versionTitle, type SavePointReason, type VersionRecord } from '@core/versions/types';
import { APP_VERSION } from '@core/model/defaults';
import { ProjectCatalog } from '../projects/catalog';
import { captureView } from '../persistence/view-snapshot';
import { zipOffThread } from '../persistence/zip-async';
import type { Services } from '../services';
import { defaultVersionBackend, type VersionBackend } from './backend';
import { createVersionSettingsStore, type VersionSettings } from './settings';
import { VersionStore } from './store';
import { VersionUse } from './use';
import { createVersionsView, type VersionsView } from './view-state';

export type { VersionsView };

/**
 * Save points and what is done with them. The service decides when a version is made (on save, after some minutes of
 * editing, before a big change, when the tab closes, when asked), keeps what the Versions window shows, and restores,
 * previews or opens a version. Where versions are kept is `VersionStore`; the service holds no storage of its own.
 */

/** A single edit that touches this many parts of the project counts as a big change worth a save point before it. */
export const BIG_EDIT_PATCH_COUNT = 150;
/** Two save points made for "a big edit" are at least this far apart (ms), so a run of pastes is not a run of versions. */
export const BIG_EDIT_MIN_GAP_MS = 2 * 60_000;
/** How often the service looks at whether the minutes of editing are up (ms). */
const TIMER_TICK_MS = 30_000;
/** A name longer than this is cut. */
const MAX_NAME_LENGTH = 80;
/** How long after the app starts the old versions are tidied (ms): not in the middle of the first paint. */
const STARTUP_TIDY_DELAY_MS = 8_000;

/** What `savePoint` can be told besides why. */
export interface SavePointOptions {
  /** The state to keep (default: the open project as it is). A "before" save point passes the state before an edit. */
  project?: Project;
  /** Compress on this thread (the page is closing). */
  urgent?: boolean;
}

export class VersionService {
  readonly view: StoreApi<VersionsView> = createVersionsView();
  readonly settings: StoreApi<VersionSettings> = createVersionSettingsStore();
  /** The records and files of versions, or null when this browser cannot keep any. */
  readonly store: VersionStore | null;
  /** The cards of the projects the browser has seen. */
  readonly catalog: ProjectCatalog | null;
  /** What is done with a version once it exists (restore, copy, preview); null with no storage. */
  private readonly use: VersionUse | null;

  /** The state of the open project when it was loaded or last given a version: "changed" means different from it. */
  private baseline: Project | null = null;
  /** Project states known to be stored. */
  private stored = new WeakSet<Project>();
  /** The last state this session stored: the next version's "what changed" is worked out against it. */
  private lastStored: Project | null = null;
  /** When the first edit since the baseline was made (ms), for the minutes of editing. */
  private firstEditAt: number | null = null;
  private lastBigEditAt = -Infinity;
  /** Writes happen one at a time, so two save points asked together cannot race each other's "what changed". */
  private queue: Promise<unknown> = Promise.resolve();
  private reportedFailure = false;
  /** The open project's versions as last read. */
  private openVersions: VersionRecord[] = [];
  private isStarted = false;

  constructor(
    private readonly s: Services,
    backend: VersionBackend | null | undefined,
    private readonly now: () => number = Date.now,
  ) {
    const kv = backend === undefined ? defaultVersionBackend() : backend;
    this.store = kv
      ? new VersionStore({
          kv: kv.kv,
          files: kv.files,
          appVersion: APP_VERSION,
          zip: zipOffThread,
          now,
          pluginInfo: (id) => s.automation.pluginInfo(id),
        })
      : null;
    this.catalog = kv ? new ProjectCatalog(kv.kv, now) : null;
    this.use = this.store
      ? new VersionUse({
          s,
          store: this.store,
          view: this.view,
          savePoint: (reason, note) => this.savePoint(reason, note),
          settled: () => this.settled(),
          versionsOf: (projectId) => this.versionsOf(projectId),
        })
      : null;
  }

  /** Whether versions can be kept in this browser. */
  get isAvailable(): boolean {
    return this.store !== null;
  }

  private get project(): Project {
    return this.s.doc.getState().project;
  }

  private toast(text: string, kind?: 'error'): void {
    this.s.session.getState().toast(text, kind);
  }

  // ---- Making save points ----

  /**
   * Keeps the project as it is now (or `options.project`) as a version. What is kept is captured at once, so an edit made
   * right after cannot slip in; the writing happens in the background. Resolves with the new version, or null when
   * there was nothing new to keep or versions cannot be kept here. Never rejects.
   */
  savePoint(reason: SavePointReason, note?: string, options: SavePointOptions = {}): Promise<VersionRecord | null> {
    const store = this.store;
    if (!store || (!this.isStarted && reason !== 'named')) return Promise.resolve(null);
    const project = options.project ?? this.project;
    if (reason !== 'named' && this.stored.has(project)) return Promise.resolve(null);
    if (this.isUnchanged(reason, project)) return Promise.resolve(null);
    const view = captureView(this.s);
    const previous = this.lastStored?.projectId === project.projectId ? this.lastStored : undefined;
    return this.enqueue(async () => {
      const record = await store.create({
        project,
        view,
        reason,
        ...(note ? { note } : {}),
        ...(previous ? { previous } : {}),
        ...(options.urgent ? { urgent: true } : {}),
      });
      this.afterWrite(project, record);
      return record;
    });
  }

  /** The automatic reasons that mean "changes since the last version" skip a project that has not changed. */
  private isUnchanged(reason: SavePointReason, project: Project): boolean {
    const isRegular = reason === 'timer' || reason === 'close' || reason === 'save';
    return isRegular && project === this.baseline;
  }

  /** Saves a version the musician asked for: named, and kept forever. */
  saveNamed(name?: string): Promise<VersionRecord | null> {
    const store = this.store;
    if (!store) {
      this.toast('This browser has no private storage, so versions cannot be saved here.', 'error');
      return Promise.resolve(null);
    }
    const project = this.project;
    const given = (name ?? '').trim().slice(0, MAX_NAME_LENGTH);
    const label = given || `Version of ${new Date(this.now()).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
    const view = captureView(this.s);
    const previous = this.lastStored?.projectId === project.projectId ? this.lastStored : undefined;
    return this.enqueue(async () => {
      const record = await store.create({ project, view, reason: 'named', name: label, ...(previous ? { previous } : {}) });
      this.afterWrite(project, record);
      return record;
    });
  }

  /** Runs one write after the writes before it; a failure is reported once and never reaches the caller. */
  private enqueue(work: () => Promise<VersionRecord | null>): Promise<VersionRecord | null> {
    const run = this.queue.then(work).catch((error: unknown) => {
      this.reportFailure(error);
      return null;
    });
    this.queue = run;
    return run;
  }

  private reportFailure(error: unknown): void {
    console.warn('Could not save a version:', error);
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    const reason = error instanceof Error ? error.message : String(error);
    this.toast(`Could not save a version: ${reason}`, 'error');
  }

  /** After a version of `project` was written (or found to be there already). */
  private afterWrite(project: Project, record: VersionRecord | null): void {
    this.stored.add(project);
    this.lastStored = project;
    if (project === this.project) {
      this.baseline = project;
      this.firstEditAt = null;
    }
    if (!record) return;
    void this.tidyAndRefresh(record.projectId);
    void this.writeCard(project, { isModified: true });
  }

  private async tidyAndRefresh(projectId: string): Promise<void> {
    try {
      await this.store?.prune(projectId, undefined, -new Date(this.now()).getTimezoneOffset());
    } catch (error) {
      console.warn('Could not tidy old versions:', error);
    }
    await this.refresh();
  }

  /** Waits for every save point asked so far to be written (tests, and before something replaces the project). */
  settled(): Promise<void> {
    return this.queue.then(
      () => undefined,
      () => undefined,
    );
  }

  // ---- When ----

  /**
   * Starts making save points: on every save, after the minutes of editing, before a very large edit and when the tab
   * closes (the app calls the explicit "before an AI answer" kinds itself). Returns a function that stops it.
   */
  start(): () => void {
    if (this.isStarted || !this.store) return () => {};
    this.isStarted = true;
    // Unsaved changes carried over a reload count as "changed since the last version".
    const hasUnsavedChanges = this.s.history.status().dirty;
    this.baseline = hasUnsavedChanges ? null : this.project;
    this.firstEditAt = hasUnsavedChanges ? this.now() : null;
    const stops = [
      this.s.history.onChange((change) => this.onDocumentChange(change)),
      this.s.files.onSaved(() => void this.onSaved()),
      // The file's name and link change just after the project does (a project opened, saved as): the card follows them.
      this.s.files.store.subscribe((state, previous) => {
        if (state.name !== previous.name || state.fileKey !== previous.fileKey) void this.writeCard(this.project, { isOpened: true });
      }),
    ];
    const interval = setInterval(() => this.checkTimer(), TIMER_TICK_MS);
    const onPageHide = () => this.saveBeforeClosing();
    globalThis.addEventListener?.('pagehide', onPageHide);
    const tidy = setTimeout(() => void this.tidyAtStart(), STARTUP_TIDY_DELAY_MS);
    void this.writeCard(this.project, { isOpened: true });
    void this.refresh();
    return () => {
      this.isStarted = false;
      stops.forEach((stop) => stop());
      clearInterval(interval);
      clearTimeout(tidy);
      globalThis.removeEventListener?.('pagehide', onPageHide);
    };
  }

  private onDocumentChange(change: DocChange): void {
    if (change.origin === 'load') {
      this.baseline = change.next;
      this.stored = new WeakSet();
      this.lastStored = null;
      this.firstEditAt = null;
      void this.refresh();
      return;
    }
    this.firstEditAt ??= this.now();
    if (change.origin !== 'edit' || !change.patches || change.patches.length < BIG_EDIT_PATCH_COUNT) return;
    if (this.now() - this.lastBigEditAt < BIG_EDIT_MIN_GAP_MS) return;
    this.lastBigEditAt = this.now();
    void this.savePoint('before-big', undefined, { project: change.prev });
  }

  private async onSaved(): Promise<void> {
    if (!this.settings.getState().isAutomatic) return;
    await this.savePoint('save');
    await this.writeCard(this.project, { isOpened: true, isModified: true });
  }

  /** The minutes of editing are up: a version of what is there now. Called every half minute; public for tests. */
  checkTimer(): void {
    const { isAutomatic, everyMinutes } = this.settings.getState();
    if (!isAutomatic || this.firstEditAt === null) return;
    if (this.now() - this.firstEditAt < everyMinutes * 60_000) return;
    void this.savePoint('timer');
  }

  /** The tab is closing: keeps what changed since the last version (best effort: the page may go first). */
  saveBeforeClosing(): void {
    if (!this.settings.getState().isAutomatic) return;
    void this.savePoint('close', undefined, { urgent: true });
  }

  /** Before something big the app is about to do (an AI answer, the arranger…): keeps the project as it is. */
  beforeBigChange(reason: Extract<SavePointReason, `before-${string}`>, note?: string): void {
    if (!this.settings.getState().isAutomatic) return;
    void this.savePoint(reason, note);
  }

  private async tidyAtStart(): Promise<void> {
    try {
      await this.store?.reconcile();
      await this.tidyAndRefresh(this.project.projectId);
    } catch (error) {
      console.warn('Could not tidy versions at start:', error);
    }
  }

  private async writeCard(project: Project, update: { isOpened?: boolean; isModified?: boolean }): Promise<void> {
    try {
      const { name, fileKey } = this.s.files.store.getState();
      await this.catalog?.write(project, { name, fileKey, ...update });
    } catch (error) {
      console.warn('Could not remember the project for the project list:', error);
    }
  }

  // ---- What the window shows ----

  /**
   * The versions of the open project as last read (for read tools, which cannot wait for storage): refreshed on start,
   * after every change to a version and whenever another project is opened.
   */
  openProjectVersions(): readonly VersionRecord[] {
    return this.openVersions;
  }

  /** The versions of the listed project (default: the open one), and the storage they use. */
  async refresh(): Promise<void> {
    const store = this.store;
    if (!store) return;
    const openId = this.project.projectId;
    const id = this.view.getState().projectId ?? openId;
    try {
      const [open, versions, project, all] = await Promise.all([
        store.list(openId),
        id === openId ? null : store.list(id),
        store.usage(id),
        store.usage(),
      ]);
      this.openVersions = open;
      const current = this.view.getState();
      if ((current.projectId ?? this.project.projectId) !== id) return; // the window moved on while we read
      this.view.setState({ versions: versions ?? open, usage: { project, all }, isLoading: false });
    } catch (error) {
      console.warn('Could not read the versions:', error);
      this.view.setState({ isLoading: false });
    }
  }

  /** Lists another project's versions in the window (null: the open project's). */
  async showVersionsOf(projectId: string | null, name = ''): Promise<void> {
    this.view.setState({ projectId, projectName: name, versions: [], isLoading: true });
    await this.refresh();
  }

  /** A project's versions, newest first (an empty list when versions cannot be kept here). */
  async versionsOf(projectId: string): Promise<VersionRecord[]> {
    return (await this.store?.list(projectId)) ?? [];
  }

  /** The version a person means by its name, "latest", or its id; null when none fits. */
  async find(reference: string, projectId: string = this.project.projectId): Promise<VersionRecord | null> {
    const versions = await this.versionsOf(projectId);
    const wanted = reference.trim().toLowerCase();
    if (!wanted || wanted === 'latest') return versions[0] ?? null;
    return (
      versions.find((v) => v.id === reference.trim()) ??
      versions.find((v) => versionTitle(v).toLowerCase() === wanted) ??
      versions.find((v) => versionTitle(v).toLowerCase().includes(wanted)) ??
      null
    );
  }

  // ---- Changing a version ----

  async setPinned(record: VersionRecord, pinned: boolean): Promise<void> {
    await this.store?.update(record, { pinned });
    await this.refresh();
  }

  async rename(record: VersionRecord, name: string): Promise<void> {
    await this.store?.update(record, { name: name.slice(0, MAX_NAME_LENGTH) });
    await this.refresh();
  }

  async remove(record: VersionRecord): Promise<void> {
    if (this.view.getState().previewingId === record.id) this.stopPreview();
    await this.store?.remove(record);
    await this.refresh();
  }

  /** Deletes every version of a project (the project, its file and its autosaves are untouched). */
  async removeAllOf(projectId: string): Promise<number> {
    const removed = (await this.store?.removeProject(projectId)) ?? 0;
    await this.refresh();
    return removed;
  }

  // ---- Using a version (src/app/versions/use.ts) ----

  /** What changed in the open project since a version: the sentences "what is different" shows. */
  changesSince(record: VersionRecord): Promise<ProjectChanges> {
    return this.use?.changesSince(record) ?? Promise.resolve({ parts: [], lines: [] });
  }

  /**
   * Puts the open project back to a version, as one undo step. The project as it is now is kept as a version first, so
   * even a restore that is later regretted past the undo history loses nothing.
   */
  restore(record: VersionRecord): Promise<boolean> {
    return this.use?.restore(record) ?? Promise.resolve(false);
  }

  /** Opens a version as a new, unsaved project, so the open one is untouched (unsaved changes are asked about first). */
  openAsCopy(record: VersionRecord): Promise<boolean> {
    return this.use?.openAsCopy(record) ?? Promise.resolve(false);
  }

  /** Opens a project's newest version as the open project, keeping its identity (for a project with versions and no file). */
  openLatestOf(projectId: string, name: string): Promise<boolean> {
    return this.use?.openLatestOf(projectId, name) ?? Promise.resolve(false);
  }

  /** Renders the start of a version and plays it, leaving the open project alone. Asking again stops it. */
  preview(record: VersionRecord): Promise<void> {
    return this.use?.preview(record) ?? Promise.resolve();
  }

  /** Stops a version's preview. */
  stopPreview(): void {
    this.use?.stopPreview();
  }
}
