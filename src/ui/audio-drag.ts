import { isAudioFileName } from '@app/persistence/sample-folders';

/**
 * Dragging audio files into editors: from the sample browser (a file handle, which can't travel in a
 * DataTransfer, so the drag carries a token) or straight from the desktop (DataTransfer files).
 */
export const AUDIO_FILE_TYPE = 'application/x-agstudio-file';
/** A built-in kit sound dragged from the browser panel (the data is its generator id). */
export const KIT_SOUND_TYPE = 'application/x-agstudio-sound';

const dragged = new Map<string, FileSystemFileHandle>();
let seq = 0;

export function startAudioFileDrag(dt: DataTransfer, handle: FileSystemFileHandle): void {
  const token = `file-${++seq}`;
  dragged.clear(); // one drag at a time
  dragged.set(token, handle);
  dt.setData(AUDIO_FILE_TYPE, token);
  dt.effectAllowed = 'copy';
}

/**
 * Whether a drag may carry audio. Desktop files can't be inspected until the drop, so any file drag
 * counts; `takeAudioFiles` then ignores drops without audio (and leaves them to the window).
 */
export function dragMayHaveAudio(dt: DataTransfer | null): boolean {
  return !!dt && (dt.types.includes(AUDIO_FILE_TYPE) || dt.types.includes('Files'));
}

/**
 * The audio files in a drop, or null when there are none (then the caller should not handle the
 * event). Call it synchronously in the drop handler: the DataTransfer is emptied afterwards.
 */
export function takeAudioFiles(dt: DataTransfer): Promise<File[]> | null {
  const token = dt.getData(AUDIO_FILE_TYPE);
  if (token) {
    const handle = dragged.get(token);
    return handle ? handle.getFile().then((f) => [f]) : null;
  }
  const files = [...dt.files].filter((f) => isAudioFileName(f.name));
  return files.length > 0 ? Promise.resolve(files) : null;
}
