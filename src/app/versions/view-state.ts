import { createStore, type StoreApi } from 'zustand/vanilla';
import type { VersionRecord } from '@core/versions/types';
import type { VersionUsage } from './store';

/** What the Versions window shows. */
export interface VersionsView {
  /** The project whose versions are listed; null is the open project. */
  projectId: string | null;
  projectName: string;
  versions: VersionRecord[];
  /** Versions of the listed project, and of every project (both with their bytes). */
  usage: { project: VersionUsage; all: VersionUsage };
  /** The list is being read. */
  isLoading: boolean;
  /** The version being heard in a preview. */
  previewingId: string | null;
  /** The version a slow step (a preview render, a restore) is working on. */
  busyId: string | null;
}

const EMPTY_USAGE: VersionUsage = { count: 0, bytes: 0 };

/** The window's state before anything has been read. */
export function createVersionsView(): StoreApi<VersionsView> {
  return createStore<VersionsView>(() => ({
    projectId: null,
    projectName: '',
    versions: [],
    usage: { project: EMPTY_USAGE, all: EMPTY_USAGE },
    isLoading: false,
    previewingId: null,
    busyId: null,
  }));
}
