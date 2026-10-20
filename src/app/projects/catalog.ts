import type { Project } from '@core/model/types';
import { cardKey, CARD_KEY_PREFIX, isProjectCard, type ProjectCard } from '@core/projects/list';
import { projectFacts } from '@core/versions/facts';
import { arrangementThumbnail } from '@core/versions/thumbnail';
import type { GcKv } from '../storage/kv';

/**
 * The cards of the projects this browser has seen: name, length, tempo, key and a small picture of the arrangement, kept
 * in IndexedDB so the project list is drawn without opening a single file. A card is written when a project is opened,
 * saved or given a version, and keeps the musician's choices (pinned, removed from the list) across those updates.
 */

/** What a card is told when it is written. */
export interface CardUpdate {
  /** The name shown: the file's name without `.agproj`. */
  name: string;
  /** Key of the remembered file handle, when the project lives in a file. */
  fileKey?: string | null;
  /** The project was opened or saved now (moves it to the top of "Last opened"). */
  isOpened?: boolean;
  /** Its content changed (a save, a version): sets "Last changed". */
  isModified?: boolean;
  /** When it happened (ms since 1970), for a card made later from an old autosave. Default: now. */
  at?: number;
}

export class ProjectCatalog {
  constructor(
    private readonly kv: GcKv,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every card (damaged records are ignored). */
  async all(): Promise<ProjectCard[]> {
    const entries = await this.kv.entries((key) => key.startsWith(CARD_KEY_PREFIX));
    return entries.map(([, value]) => value).filter(isProjectCard);
  }

  async get(projectId: string): Promise<ProjectCard | null> {
    const found = (await this.kv.getMany([cardKey(projectId)])).get(cardKey(projectId));
    return isProjectCard(found) ? found : null;
  }

  /** Writes the card of `project`, keeping what the musician chose. Returns it. */
  async write(project: Project, update: CardUpdate): Promise<ProjectCard> {
    const old = await this.get(project.projectId);
    const at = update.at ?? this.now();
    const fileKey = update.fileKey === undefined ? old?.fileKey : (update.fileKey ?? undefined);
    const isActive = update.isOpened === true || update.isModified === true;
    const card: ProjectCard = {
      v: 1,
      projectId: project.projectId,
      name: update.name,
      ...(fileKey ? { fileKey } : {}),
      lastOpenedAt: update.isOpened ? at : (old?.lastOpenedAt ?? at),
      lastModifiedAt: update.isModified ? at : (old?.lastModifiedAt ?? at),
      facts: projectFacts(project),
      thumbnail: arrangementThumbnail(project),
      pinned: old?.pinned ?? false,
      // Using a project again brings it back to the list.
      removed: isActive ? false : (old?.removed ?? false),
    };
    await this.kv.set([[cardKey(card.projectId), card]]);
    return card;
  }

  /**
   * Changes what the musician chose about a card. A project with no card yet (listed from a version or an autosave) gets
   * a bare one named `name`, so the choice is kept.
   */
  async choose(projectId: string, choice: { pinned?: boolean; removed?: boolean }, name = 'Untitled'): Promise<void> {
    const at = this.now();
    const old = (await this.get(projectId)) ?? {
      v: 1 as const,
      projectId,
      name,
      lastOpenedAt: at,
      lastModifiedAt: at,
      facts: { bars: 0, lengthSec: 0, bpm: 0, key: null, clips: 0, patterns: 0, channels: 0 },
      thumbnail: null,
      pinned: false,
      removed: false,
    };
    await this.kv.set([[cardKey(projectId), { ...old, ...choice }]]);
  }
}
