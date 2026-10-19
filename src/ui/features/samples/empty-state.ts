/** What the sample browser says in place of the list when there is nothing to list (pure). */
import { addSampleFolder, canPickFolders, reconnectSampleFolder, type FolderState } from '@app/persistence/sample-folders';
import {
  EMPTY_NO_AUDIO_TEXT,
  EMPTY_NO_FOLDERS_TEXT,
  EMPTY_NO_FOLDERS_TITLE,
  EMPTY_NO_MATCH_TEXT,
  EMPTY_RECONNECT_TEXT,
} from './view';

/** A message with a title, an explanation and, when there is a useful next step, a button for it. */
export interface EmptyState {
  title: string;
  text: string;
  action?: { label: string; hint: string; run(): void };
}

/** What the empty state needs to know about the window right now. */
export interface EmptyStateInput {
  folders: readonly FolderState[];
  rowCount: number;
  visibleCount: number;
  isShowingSimilar: boolean;
  hasActiveFilter: boolean;
  clearAllFilters(): void;
}

const NO_FOLDER_PICKER_TEXT = 'Sample folders need Chrome or Edge. You can still drag audio files from your computer onto the channel rack or the playlist.';

/** The folder list is empty: ask for a folder, or explain why this browser cannot pick one. */
function noFoldersState(): EmptyState {
  if (!canPickFolders()) return { title: EMPTY_NO_FOLDERS_TITLE, text: NO_FOLDER_PICKER_TEXT };
  return {
    title: EMPTY_NO_FOLDERS_TITLE,
    text: EMPTY_NO_FOLDERS_TEXT,
    action: {
      label: 'Add folder…',
      hint: 'Pick a folder of your sounds (it stays on your computer; the browser keeps its place)',
      run: () => void addSampleFolder(),
    },
  };
}

/** Folders are listed but the browser lost its permission to read them (usually after a reload). */
function needsAccessState(folders: readonly FolderState[]): EmptyState {
  return {
    title: 'Allow access to your folders',
    text: EMPTY_RECONNECT_TEXT,
    action: {
      label: 'Reconnect…',
      hint: 'The browser asks again whether AGstudio may read your sample folders',
      run: () => folders.filter((f) => f.access !== 'granted').forEach((f) => void reconnectSampleFolder(f.key)),
    },
  };
}

/** Rows exist but the filters (or the "similar sounds" view) leave none. */
function nothingVisibleState(input: EmptyStateInput): EmptyState {
  const title = input.isShowingSimilar ? 'Nothing similar yet' : 'No match';
  const text = input.isShowingSimilar ? 'The other sounds are still being analyzed. Try again in a moment.' : EMPTY_NO_MATCH_TEXT;
  if (!input.hasActiveFilter) return { title, text };
  return { title, text, action: { label: 'Clear filters', hint: 'Show every sound again', run: input.clearAllFilters } };
}

/** The message to show instead of the list, or null when the list has rows to show. */
export function pickEmptyState(input: EmptyStateInput): EmptyState | null {
  const { folders, rowCount, visibleCount } = input;
  if (folders.length === 0) return noFoldersState();
  const needsAccess = folders.some((f) => f.access !== 'granted');
  const isScanning = folders.some((f) => f.loading);
  if (rowCount === 0 && needsAccess) return needsAccessState(folders);
  if (rowCount === 0 && !isScanning) return { title: 'No audio found', text: EMPTY_NO_AUDIO_TEXT };
  if (rowCount === 0) return { title: 'Reading your folders…', text: 'Looking for audio files. This takes a moment for big folders.' };
  if (visibleCount === 0) return nothingVisibleState(input);
  return null;
}
