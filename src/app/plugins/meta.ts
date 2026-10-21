import { idbGet, idbSet, isIdbAvailable } from '@platform/idb';

/**
 * What AGstudio remembers about a user plugin that its code does not say: who made it and where it came from. Kept in this
 * browser (the code itself lives in `plugins/<folder>/`). Losing it loses only the author name in the list.
 */
export interface PluginMetaEntry {
  author?: string;
  /** How it got here: a shared bundle, the gallery, the plugin builder or a copy of another plugin of yours. */
  origin?: 'bundle' | 'gallery' | 'builder' | 'copy';
  /** Milliseconds since 1970. */
  installedAt?: number;
}

/** Where the notes are kept (IndexedDB; tests pass a memory one). */
export interface PluginMetaStorage {
  read(): Promise<unknown>;
  write(all: Record<string, PluginMetaEntry>): Promise<void>;
}

const KEY = 'user-plugin-meta:v1';

export const idbPluginMeta: PluginMetaStorage = {
  read: () => (isIdbAvailable() ? idbGet(KEY) : Promise.resolve({})),
  write: (all) => (isIdbAvailable() ? idbSet(KEY, all) : Promise.resolve()),
};

/** A storage that keeps the notes only as long as the page lives. */
export function memoryPluginMeta(initial: Record<string, PluginMetaEntry> = {}): PluginMetaStorage & { all: Record<string, PluginMetaEntry> } {
  const store = {
    all: initial,
    read: () => Promise.resolve(store.all),
    write: (all: Record<string, PluginMetaEntry>) => {
      store.all = structuredClone(all);
      return Promise.resolve();
    },
  };
  return store;
}

const isEntry = (value: unknown): value is PluginMetaEntry => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The notes about every plugin, loaded once and written back after each change. */
export class PluginMeta {
  private entries: Record<string, PluginMetaEntry> = {};
  private readonly loading: Promise<void>;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: PluginMetaStorage = idbPluginMeta) {
    this.loading = storage
      .read()
      .then((raw) => {
        const saved = isEntry(raw) ? raw : {};
        const merged: Record<string, PluginMetaEntry> = {};
        for (const [id, entry] of Object.entries(saved)) if (isEntry(entry)) merged[id] = entry;
        this.entries = { ...merged, ...this.entries };
        this.emit();
      })
      .catch(() => {});
  }

  /** Resolves when the saved notes have been read. */
  ready(): Promise<void> {
    return this.loading;
  }

  get(id: string): PluginMetaEntry {
    return this.entries[id] ?? {};
  }

  /** Adds to what is known about a plugin. */
  set(id: string, entry: PluginMetaEntry): void {
    this.entries = { ...this.entries, [id]: { ...this.entries[id], ...entry } };
    this.emit();
    void this.loading.then(() => this.storage.write(this.entries)).catch(() => {});
  }

  /** Moves the notes of a plugin to its new id. */
  rename(from: string, to: string): void {
    const entry = this.entries[from];
    if (!entry) return;
    const rest = { ...this.entries };
    delete rest[from];
    this.entries = { ...rest, [to]: entry };
    this.emit();
    void this.loading.then(() => this.storage.write(this.entries)).catch(() => {});
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
