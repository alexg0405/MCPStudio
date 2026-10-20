import { createStore, type StoreApi } from 'zustand/vanilla';
import type { HistorySnapshot } from '@core/history/history';
import type { Project } from '@core/model/types';
import { createDemoProject, DEMO_TITLE } from './demo-project';
import { applyView, captureView, type ViewSnapshot } from './persistence/view-snapshot';
import type { FileState } from './project-files';
import type { Services } from './services';

/** What `begin()` keeps of the musician's own project until `end()` puts it back. */
interface KeptProject {
  history: HistorySnapshot;
  view: ViewSnapshot;
  file: Pick<FileState, 'name' | 'handle' | 'fileKey'>;
}

/**
 * A demo song on screen while a guided tour runs, with the musician's own project kept safe.
 *
 * `begin()` keeps everything about the open project (the song, its undo and redo steps, whether it has unsaved changes,
 * the window layout, the file it belongs to), makes a version of it first when it has unsaved changes (so even a crashed
 * tab can bring it back from Versions), then shows the demo song as an unsaved project with no file: Save can never
 * overwrite the musician's file with the demo. `end()` puts all of it back exactly as it was. Anything that would replace
 * the project meanwhile (New, Open, recovery…) ends the demo first, so it asks about the musician's song, not the demo.
 */
export class DemoSession {
  /** Whether the demo song is the open project. */
  readonly store: StoreApi<{ active: boolean }> = createStore<{ active: boolean }>(() => ({ active: false }));
  private kept: KeptProject | null = null;
  private isStarting = false;

  constructor(private readonly s: Services) {}

  get active(): boolean {
    return this.kept !== null;
  }

  /**
   * The musician's own project while the demo is on screen (null otherwise): what the reload snapshot and the crash autosave
   * write instead of the demo, so a reload or a crash in the middle of a tour brings the musician's project back, not the demo.
   */
  get own(): { project: Project; view: ViewSnapshot; name: string; fileKey: string | null; isDirty: boolean } | null {
    const kept = this.kept;
    if (!kept) return null;
    return {
      project: kept.history.project,
      view: kept.view,
      name: kept.file.name,
      fileKey: kept.file.fileKey,
      isDirty: kept.history.dirty,
    };
  }

  /** Shows the demo song. Does nothing when the demo is already on screen (or about to be). */
  async begin(): Promise<void> {
    if (this.kept || this.isStarting) return;
    const { s } = this;
    // A version of unsaved work is the net under the net: it survives a crash or a closed tab during the tour.
    if (s.history.status().dirty) {
      this.isStarting = true;
      await s.versions.savePoint('before-big', 'a guided tour opened its demo song').catch(() => null);
      this.isStarting = false;
    }
    if (this.kept) return;
    const file = s.files.store.getState();
    // Kept after the version was written, so edits made meanwhile are in it.
    this.kept = {
      history: s.history.snapshot(),
      view: captureView(s),
      file: { name: file.name, handle: file.handle, fileKey: file.fileKey },
    };
    s.files.setBeforeReplace(() => this.end());
    s.files.replace(
      createDemoProject(s.plugins),
      null,
      { name: DEMO_TITLE, handle: null, fileKey: null },
      { dirty: true },
    );
    this.store.setState({ active: true });
  }

  /** Puts the musician's own project back, with its undo steps, layout and file. Does nothing when no demo is shown. */
  end(): void {
    const kept = this.kept;
    if (!kept) return;
    const { s } = this;
    this.kept = null;
    s.files.setBeforeReplace(null);
    s.engine.stop();
    s.history.restore(kept.history);
    applyView(s, kept.view, kept.history.project);
    s.files.store.setState(kept.file);
    this.store.setState({ active: false });
  }
}
