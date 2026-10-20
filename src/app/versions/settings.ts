import { createStore, type StoreApi } from 'zustand/vanilla';

/** What the musician can set about save points. Kept in this browser (not in a project). */
export interface VersionSettings {
  /** Make save points by itself (on save, every few minutes of editing, before big changes, on close). */
  isAutomatic: boolean;
  /** Minutes of editing between two automatic save points. */
  everyMinutes: number;
}

/** The choices the Versions window offers for "every N minutes". */
export const EVERY_MINUTES_CHOICES: readonly number[] = [2, 5, 10, 20, 30];
export const DEFAULT_VERSION_SETTINGS: VersionSettings = { isAutomatic: true, everyMinutes: 10 };

const STORAGE_KEY = 'agstudio:versions-settings';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Reads the saved settings; anything missing or odd falls back to the default. */
export function readVersionSettings(): VersionSettings {
  try {
    const raw = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? 'null') as Partial<VersionSettings> | null;
    const minutes = raw?.everyMinutes;
    return {
      isAutomatic: raw?.isAutomatic !== false,
      everyMinutes:
        typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 1 && minutes <= 240
          ? Math.round(minutes)
          : DEFAULT_VERSION_SETTINGS.everyMinutes,
    };
  } catch {
    return { ...DEFAULT_VERSION_SETTINGS };
  }
}

/** A store of the settings that writes every change back to this browser. */
export function createVersionSettingsStore(): StoreApi<VersionSettings> {
  const store = createStore<VersionSettings>(() => readVersionSettings());
  store.subscribe((settings) => {
    try {
      storage()?.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage is blocked: the choice lasts until the tab closes */
    }
  });
  return store;
}
