import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';
import type { Project } from '../model/types';

enablePatches();

/**
 * The single write funnel for the project document. Every change is undoable (loading a project
 * clears history). Recipes are Immer draft mutators; prefer reading from the frozen state and
 * writing by id on the draft (iterating a draft of 10k notes allocates 10k proxies).
 */

export type Recipe = (draft: Draft<Project>) => void;
export type Origin = 'edit' | 'gesture' | 'undo' | 'redo' | 'load';

export interface DocChange {
  next: Project;
  prev: Project;
  /** Forward patches prev → next, or null for a full replacement (load). */
  patches: Patch[] | null;
  origin: Origin;
}

/** Where the document lives (a Zustand store in the app, a plain variable in tests). */
export interface DocContainer {
  get(): Project;
  set(project: Project): void;
}

export interface HistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  /** Identifies the current document state (the id of the newest undo entry, 0 for none). */
  cursor: number;
  /** The document differs from the last saved (or loaded) state. See `markSaved()`. */
  dirty: boolean;
}

export interface Gesture {
  /** Applies a recipe on top of the gesture's current state and notifies listeners immediately. */
  update(recipe: Recipe): void;
  /** Records everything since the gesture began as one undo entry. */
  commit(): void;
  /** Reverts to the state before the gesture (Escape). */
  cancel(): void;
  readonly active: boolean;
}

interface Entry {
  id: number;
  label: string;
  patches: Patch[];
  inverse: Patch[];
  mergeKey?: string;
  time: number;
}

const samePath = (a: Patch['path'], b: Patch['path']) => a.length === b.length && a.every((p, i) => p === b[i]);

/**
 * Shrinks replace-only patch sequences (a fader drag) to one patch per path: last value forward,
 * first value backward. Sequences containing adds/removes are kept verbatim.
 */
function compact(patches: Patch[], inverse: Patch[]): { patches: Patch[]; inverse: Patch[] } {
  if (patches.some((p) => p.op !== 'replace') || inverse.some((p) => p.op !== 'replace')) return { patches, inverse };
  const fwd: Patch[] = [];
  for (const p of patches) {
    const i = fwd.findIndex((q) => samePath(q.path, p.path));
    if (i >= 0) fwd[i] = p;
    else fwd.push(p);
  }
  // `inverse` is already newest-first; the base value for a path is its last occurrence.
  const inv: Patch[] = [];
  for (let k = inverse.length - 1; k >= 0; k--) {
    const p = inverse[k] as Patch;
    if (!inv.some((q) => samePath(q.path, p.path))) inv.unshift(p);
  }
  return { patches: fwd, inverse: inv };
}

export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<(change: DocChange) => void>();
  private statusListeners = new Set<() => void>();
  private seq = 0;
  /** Cursor of the saved state; -1 when no saved state is reachable by undo/redo. */
  private savedCursor = 0;
  private gestureActive: { commit(): void } | null = null;
  /** The active gesture has changed the document (it isn't in the undo stack until it commits). */
  private gestureChanged = false;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly mergeWindowMs: number;

  constructor(
    private readonly container: DocContainer,
    opts: { limit?: number; now?: () => number; mergeWindowMs?: number } = {},
  ) {
    this.limit = opts.limit ?? 500;
    this.now = opts.now ?? Date.now;
    this.mergeWindowMs = opts.mergeWindowMs ?? 1000;
  }

  get project(): Project {
    return this.container.get();
  }

  onChange(fn: (change: DocChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Applies a recipe as one undo entry. Returns false when the recipe changed nothing. */
  transact(label: string, recipe: Recipe, opts: { mergeKey?: string } = {}): boolean {
    this.gestureActive?.commit();
    const prev = this.container.get();
    const [next, patches, inverse] = produceWithPatches(prev, recipe);
    if (patches.length === 0) return false;
    this.container.set(next);
    const time = this.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      opts.mergeKey &&
      top &&
      top.mergeKey === opts.mergeKey &&
      this.redoStack.length === 0 &&
      time - top.time < this.mergeWindowMs
    ) {
      const merged = compact([...top.patches, ...patches], [...inverse, ...top.inverse]);
      top.patches = merged.patches;
      top.inverse = merged.inverse;
      top.time = time;
    } else {
      this.push({
        id: ++this.seq,
        label,
        patches,
        inverse,
        time,
        ...(opts.mergeKey ? { mergeKey: opts.mergeKey } : {}),
      });
    }
    this.emit({ next, prev, patches, origin: 'edit' });
    return true;
  }

  gesture(label: string): Gesture {
    this.gestureActive?.commit();
    let forward: Patch[] = [];
    let backward: Patch[] = [];
    let active = true;
    const gesture: Gesture = {
      get active() {
        return active;
      },
      update: (recipe) => {
        if (!active) return;
        const prev = this.container.get();
        const [next, patches, inverse] = produceWithPatches(prev, recipe);
        if (patches.length === 0) return;
        forward = forward.concat(patches);
        backward = inverse.concat(backward);
        this.gestureChanged = true;
        this.container.set(next);
        this.emit({ next, prev, patches, origin: 'gesture' });
      },
      commit: () => {
        if (!active) return;
        active = false;
        if (this.gestureActive === gesture) {
          this.gestureActive = null;
          this.gestureChanged = false;
        }
        if (forward.length === 0) return;
        const c = compact(forward, backward);
        this.push({ id: ++this.seq, label, patches: c.patches, inverse: c.inverse, time: this.now() });
        this.emitStatus();
      },
      cancel: () => {
        if (!active) return;
        active = false;
        if (this.gestureActive === gesture) {
          this.gestureActive = null;
          this.gestureChanged = false;
        }
        if (forward.length === 0) return;
        const prev = this.container.get();
        const next = applyPatches(prev, backward);
        this.container.set(next);
        this.emit({ next, prev, patches: backward, origin: 'gesture' });
      },
    };
    this.gestureActive = gesture;
    return gesture;
  }

  undo(): boolean {
    this.gestureActive?.commit();
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const prev = this.container.get();
    const next = applyPatches(prev, entry.inverse);
    this.container.set(next);
    this.redoStack.push(entry);
    this.emit({ next, prev, patches: entry.inverse, origin: 'undo' });
    return true;
  }

  redo(): boolean {
    this.gestureActive?.commit();
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const prev = this.container.get();
    const next = applyPatches(prev, entry.patches);
    this.container.set(next);
    this.undoStack.push(entry);
    this.emit({ next, prev, patches: entry.patches, origin: 'redo' });
    return true;
  }

  /**
   * Replaces the document (open/new project) and clears history. The loaded state counts as saved
   * unless `dirty` (e.g. work recovered after a crash, which exists in no file yet).
   */
  load(project: Project, opts: { dirty?: boolean } = {}): void {
    this.gestureActive = null;
    this.gestureChanged = false;
    const prev = this.container.get();
    this.undoStack = [];
    this.redoStack = [];
    this.savedCursor = opts.dirty ? -1 : 0;
    this.container.set(project);
    this.emit({ next: project, prev, patches: null, origin: 'load' });
  }

  /**
   * Pins the current document state for a save that finishes later: commits an open gesture, stops
   * the newest entry from merging (so later edits register as changes) and returns its cursor.
   */
  checkpoint(): number {
    this.gestureActive?.commit();
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) delete top.mergeKey;
    return top?.id ?? 0;
  }

  /**
   * Records a state as saved: the current one, or the `checkpoint()` a save captured before it
   * started (edits made while saving keep the document dirty). Undoing or redoing back to the saved
   * state makes the document clean again.
   */
  markSaved(cursor: number = this.checkpoint()): void {
    const reachable =
      cursor === 0 || this.undoStack.some((e) => e.id === cursor) || this.redoStack.some((e) => e.id === cursor);
    this.savedCursor = reachable ? cursor : -1;
    this.emitStatus();
  }

  /** Forgets the saved state (e.g. the file it was saved to is gone): the document is dirty. */
  markUnsaved(): void {
    this.savedCursor = -1;
    this.emitStatus();
  }

  status(): HistoryStatus {
    const top = this.undoStack[this.undoStack.length - 1];
    const redo = this.redoStack[this.redoStack.length - 1];
    return {
      canUndo: !!top,
      canRedo: !!redo,
      ...(top ? { undoLabel: top.label } : {}),
      ...(redo ? { redoLabel: redo.label } : {}),
      cursor: top?.id ?? 0,
      dirty: (top?.id ?? 0) !== this.savedCursor || this.gestureChanged,
    };
  }

  /** Status listeners (undo/redo availability) without document payloads. */
  onStatus(fn: () => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private push(entry: Entry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) {
      const dropped = this.undoStack.splice(0, this.undoStack.length - this.limit);
      // The state after the last dropped entry is the new bottom (cursor 0); anything older is gone.
      const base = (dropped[dropped.length - 1] as Entry).id;
      if (this.savedCursor === base) this.savedCursor = 0;
      else if (this.savedCursor === 0 || dropped.some((e) => e.id === this.savedCursor)) this.savedCursor = -1;
    }
    // Redo entries are discarded; if the saved state was among them, it is unreachable now.
    if (this.redoStack.some((e) => e.id === this.savedCursor)) this.savedCursor = -1;
    this.redoStack = [];
  }

  private emit(change: DocChange): void {
    for (const fn of this.listeners) fn(change);
    this.emitStatus();
  }

  private emitStatus(): void {
    for (const fn of this.statusListeners) fn();
  }
}
