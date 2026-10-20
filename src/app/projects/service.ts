import { createStore, type StoreApi } from 'zustand/vanilla';
import { newId } from '@core/model/ids';
import type { Project } from '@core/model/types';
import {
  mergeProjectList,
  type ListedProject,
  type ProjectCard,
  type RecentFileInfo,
  type VersionSummary,
} from '@core/projects/list';
import { projectFacts } from '@core/versions/facts';
import { arrangementThumbnail } from '@core/versions/thumbnail';
import { isOpfsAvailable, listAutosaves, type AutosaveMeta } from '@platform/opfs';
import { loadAutosave } from '../persistence/autosave';
import { forgetFile, loadRecentFiles } from '../persistence/recent-files';
import { loadRecovery } from '../persistence/session';
import type { Services } from '../services';

/**
 * Your projects as a list: the files the app remembers, the work it autosaved and the projects that have versions, with
 * what a card shows (name, length, tempo, key, a picture of the arrangement) and the things to do with each one: open it,
 * open a copy, see its versions, pin it, take it off the list.
 */

/** Autosaves read at most this many at a time to make cards for work the app saw before cards existed. */
const MIGRATE_AUTOSAVES_PER_REFRESH = 6;

/** Where the list reads from: the remembered files and the autosaves (the real ones by default; tests pass fakes). */
export interface ProjectSources {
  recentFiles(): Promise<readonly RecentFileInfo[]>;
  autosaves(): Promise<AutosaveMeta[]>;
  /** An autosave's project, or null when it cannot be read. */
  loadAutosave(sessionId: string): Promise<{ project: Project } | null>;
}

const realSources: ProjectSources = {
  recentFiles: () => loadRecentFiles(),
  async autosaves() {
    if (!isOpfsAvailable()) return [];
    try {
      return await listAutosaves();
    } catch {
      return [];
    }
  },
  loadAutosave: (sessionId) => loadAutosave(sessionId),
};

export interface ProjectsView {
  items: ListedProject[];
  /** The list is being put together. */
  isLoading: boolean;
}

export class ProjectsService {
  readonly view: StoreApi<ProjectsView> = createStore<ProjectsView>(() => ({ items: [], isLoading: false }));

  constructor(
    private readonly s: Services,
    private readonly sources: ProjectSources = realSources,
  ) {}

  private get versions() {
    return this.s.versions;
  }

  private toast(text: string, kind?: 'error'): void {
    this.s.session.getState().toast(text, kind);
  }

  /** Reads everything the list is made of and puts it together (unsorted: the window sorts and filters). */
  async list(): Promise<ListedProject[]> {
    const catalog = this.versions.catalog;
    const store = this.versions.store;
    const [recents, autosaves] = await Promise.all([this.sources.recentFiles(), this.sources.autosaves()]);
    let cards: ProjectCard[] = catalog ? await catalog.all() : [];
    if (catalog && (await this.makeCardsForOldAutosaves(autosaves, cards))) cards = await catalog.all();
    cards = cards.map((card) => this.withLiveNumbers(card));
    const summaries = new Map<string, VersionSummary>();
    for (const [projectId, versions] of store ? await store.listAll() : []) {
      const newest = versions[0];
      if (newest) summaries.set(projectId, { count: versions.length, newestAt: newest.createdAt, title: newest.title });
    }
    return mergeProjectList({
      cards,
      recents,
      autosaves,
      versions: summaries,
      openProjectId: this.s.doc.getState().project.projectId,
    });
  }

  /**
   * Autosaves made before project cards existed have no card: read the newest few and make theirs, so they show their
   * length, tempo and picture too. Returns whether any card was made.
   */
  /** The open project's card shows the song as it is now, not as it was when the card was last written. */
  private withLiveNumbers(card: ProjectCard): ProjectCard {
    const project = this.s.doc.getState().project;
    if (card.projectId !== project.projectId) return card;
    return { ...card, facts: projectFacts(project), thumbnail: arrangementThumbnail(project) };
  }

  private async makeCardsForOldAutosaves(autosaves: readonly AutosaveMeta[], cards: readonly ProjectCard[]): Promise<boolean> {
    const known = new Set(cards.map((card) => card.projectId));
    const missing = autosaves.filter((meta) => !known.has(meta.projectId) && !meta.clean).slice(0, MIGRATE_AUTOSAVES_PER_REFRESH);
    let made = false;
    for (const meta of missing) {
      try {
        const saved = await this.sources.loadAutosave(meta.sessionId);
        if (!saved) continue;
        const at = Date.parse(meta.savedAt);
        await this.versions.catalog?.write(saved.project, {
          name: meta.title || 'Untitled',
          fileKey: meta.fileKey ?? null,
          isOpened: true,
          isModified: true,
          ...(Number.isNaN(at) ? {} : { at }),
        });
        made = true;
      } catch (error) {
        console.warn('Could not read an autosave for the project list:', error);
      }
    }
    return made;
  }

  /** Reads the list into `view`. */
  async refresh(): Promise<void> {
    this.view.setState({ isLoading: true });
    try {
      this.view.setState({ items: await this.list(), isLoading: false });
    } catch (error) {
      console.warn('Could not list the projects:', error);
      this.view.setState({ isLoading: false });
    }
  }

  async setPinned(item: ListedProject, pinned: boolean): Promise<void> {
    if (!item.projectId) return;
    await this.versions.catalog?.choose(item.projectId, { pinned }, item.name);
    await this.refresh();
  }

  /** Takes a project off the list. Its file, autosaves and versions stay where they are. */
  async removeFromList(item: ListedProject): Promise<void> {
    if (item.fileKey) await forgetFile(item.fileKey);
    if (item.projectId) await this.versions.catalog?.choose(item.projectId, { removed: true }, item.name);
    await this.refresh();
  }

  /** Opens the project: its file, its unsaved autosave, or its newest version. */
  async open(item: ListedProject): Promise<boolean> {
    if (item.isOpen) return true;
    if (item.source === 'file' && item.fileKey) return this.s.files.openRecent(item.fileKey);
    if (item.source === 'autosave') return this.openAutosave(item);
    if (item.projectId) return this.versions.openLatestOf(item.projectId, item.name);
    this.toast(`There is nothing to open for “${item.name}”.`, 'error');
    return false;
  }

  /** Opens a copy: the same song with a new identity, unsaved, so the original and its versions are untouched. */
  async openCopy(item: ListedProject): Promise<boolean> {
    if (item.source === 'file' && item.fileKey) return this.s.files.openRecentAsCopy(item.fileKey);
    const latest = item.projectId ? (await this.versions.versionsOf(item.projectId))[0] : undefined;
    if (latest) return this.versions.openAsCopy(latest);
    if (item.source === 'autosave') return this.openAutosave(item, { asCopy: true });
    this.toast(`There is nothing to copy for “${item.name}”.`, 'error');
    return false;
  }

  private async openAutosave(item: ListedProject, opts: { asCopy?: boolean } = {}): Promise<boolean> {
    const meta = (await this.sources.autosaves()).find((m) => m.sessionId === item.sessionId);
    if (!meta) {
      this.toast(`The autosave of “${item.name}” is gone.`, 'error');
      return false;
    }
    if (!(await this.s.files.confirmReplace())) return false;
    const restored = await loadRecovery(meta).catch(() => null);
    if (!restored) {
      this.toast(`The autosave of “${item.name}” can’t be read.`, 'error');
      return false;
    }
    const project: Project = opts.asCopy ? { ...restored.project, projectId: newId.project() } : restored.project;
    const file = opts.asCopy
      ? { name: `${restored.file.name} (copy)`, handle: null, fileKey: null }
      : { name: restored.file.name, handle: restored.handle, fileKey: restored.file.fileKey };
    this.s.files.replace(project, restored.view, file, { dirty: true });
    return true;
  }

  /** Shows the project's versions in the Versions window (the caller opens the window). */
  async showVersions(item: ListedProject): Promise<void> {
    await this.versions.showVersionsOf(item.isOpen ? null : (item.projectId ?? null), item.name);
  }
}
