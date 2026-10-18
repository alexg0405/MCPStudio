/** Where controller mappings are kept: per device name, in this browser (IndexedDB), next to whether the controllers were switched on. */
import { idbGet, idbSet, isIdbAvailable } from '@platform/idb';

/** What is kept about the controllers between sessions. */
export interface SavedControllers {
  /** The musician connected controllers last time (so they come back on reload). */
  enabled: boolean;
  /** Mappings the musician made or changed, by device name (untouched presets are not stored). */
  mappings: Record<string, unknown>;
}

/** Where the controller settings are kept. */
export interface ControllerStorage {
  load(): Promise<SavedControllers>;
  save(data: SavedControllers): Promise<void>;
}

const KEY = 'dj-controllers';

/** Keeps the controller settings in this browser's key-value store. */
export const idbControllerStorage: ControllerStorage = {
  async load() {
    if (!isIdbAvailable()) return { enabled: false, mappings: {} };
    try {
      const v = await idbGet<SavedControllers>(KEY);
      if (v && typeof v === 'object') return { enabled: v.enabled === true, mappings: v.mappings && typeof v.mappings === 'object' ? v.mappings : {} };
    } catch {
      // Storage unavailable: start empty.
    }
    return { enabled: false, mappings: {} };
  },
  async save(data) {
    if (!isIdbAvailable()) return;
    await idbSet(KEY, data).catch(() => {});
  },
};

/** For tests: a store in memory. */
export function memoryControllerStorage(initial?: Partial<SavedControllers>): ControllerStorage & { data: SavedControllers } {
  const box = { data: { enabled: initial?.enabled ?? false, mappings: { ...initial?.mappings } } as SavedControllers };
  return {
    get data() {
      return box.data;
    },
    async load() {
      return structuredClone(box.data);
    },
    async save(d) {
      box.data = structuredClone(d);
    },
  };
}
