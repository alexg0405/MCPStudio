import type { Services } from '@app/services';
import { storageService } from '@app/storage/service';
import { formatSize, plural } from '@core/gc/format';
import { showDialog } from '../../controls/Dialog';

/**
 * "Clean up unused audio…": says what would go (how many files and how much space), asks, then removes
 * it. Reachable from Options and from Settings → Storage, and the Studio can run it too (the dialog is
 * the confirm, so nothing is removed without a click).
 */
export async function cleanUpUnusedAudio(s: Services): Promise<void> {
  const toast = s.session.getState().toast;
  const svc = storageService();
  if (!svc || !svc.status.getState().supported) {
    toast('Cleaning up needs browser storage, which this browser doesn’t allow here.', 'error');
    return;
  }
  if (svc.status.getState().running) {
    toast('A cleanup is already running.');
    return;
  }
  let summary;
  try {
    summary = await svc.preview();
  } catch (e) {
    toast(`Couldn’t check your storage: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return;
  }
  if (summary.blocked) {
    toast(summary.blocked, 'error');
    return;
  }
  if (summary.files === 0) {
    toast(
      summary.waitingFiles > 0
        ? `Nothing to clean up yet. ${plural(summary.waitingFiles, 'unused audio file')} (${formatSize(summary.waitingBytes)}) stays for a week in case you need ${summary.waitingFiles === 1 ? 'it' : 'them'} back.`
        : 'Nothing to clean up: all your stored audio is in use.',
    );
    return;
  }
  const choice = await showDialog({
    title: 'Clean up unused audio?',
    message: `Remove ${plural(summary.files, 'audio file')} (${formatSize(summary.bytes)}) that nothing uses?`,
    detail:
      'None of it is in an open project, its undo history, an autosave or your DJ library, and it has been unused for over a week. ' +
      'Projects you saved to a file keep their own copy of their audio.' +
      (summary.waitingFiles > 0
        ? ` ${plural(summary.waitingFiles, 'more file')} (${formatSize(summary.waitingBytes)}) stays until it has been unused for a week.`
        : ''),
    buttons: [
      { id: 'keep', label: 'Keep it' },
      { id: 'clean', label: 'Clean up', primary: true, danger: true },
    ],
    cancelId: 'keep',
  });
  if (choice !== 'clean') return;
  const result = await svc.cleanUp();
  if (result.status === 'done') {
    toast(
      result.removed === 0
        ? 'Nothing was removed: it is in use again.'
        : `Removed ${plural(result.removed, 'unused audio file')}, freeing ${formatSize(result.bytes)}.`,
    );
  } else if (result.status === 'skipped') {
    toast(
      result.reason === 'locked'
        ? 'Another tab is cleaning up right now.'
        : result.reason === 'busy'
          ? 'An export or import is running. Try again when it finishes.'
          : result.reason === 'tab-starting'
            ? 'Another AGstudio tab is still starting up. Try again in a moment.'
            : 'Nothing was removed. Your audio is safe; try again later.',
      'error',
    );
  }
}
