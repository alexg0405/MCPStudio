import type { Services } from '@app/services';
import { missingSoundsNotice } from '@app/persistence/project-io';
import { discardRecovery, loadRecovery, type AutosaveMeta, type SessionPersistence } from '@app/persistence/session';
import { showDialog } from '../../controls/Dialog';

/** Offers to bring back work from sessions that ended without saving (newest first, one at a time). */
export async function offerRecovery(
  s: Services,
  candidates: readonly AutosaveMeta[],
  persistence: SessionPersistence,
): Promise<void> {
  const meta = candidates[0];
  if (!meta) return;
  const title = meta.title || 'Untitled';
  const when = new Date(meta.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const more = candidates.length > 1 ? ` ${candidates.length - 1} more after this one.` : '';
  const choice = await showDialog({
    title: 'Recover unsaved work?',
    message: `"${title}" has changes from ${when} that were never saved.`,
    detail: `AGstudio was closed before they were saved. Recovering opens them as an unsaved project.${more}`,
    buttons: [
      { id: 'later', label: 'Not now' },
      { id: 'discard', label: 'Discard', danger: true },
      { id: 'recover', label: 'Recover', primary: true },
    ],
    cancelId: 'later',
  });
  if (choice === 'later') return;
  if (choice === 'discard') {
    await discardRecovery(meta).catch(() => {});
    return offerRecovery(s, candidates.slice(1), persistence);
  }
  if (!(await s.files.confirmReplace())) return;
  const restored = await loadRecovery(meta).catch((e: unknown) => {
    console.error('Recovery failed', e);
    return null;
  });
  if (!restored) {
    s.session.getState().toast(`The autosave of "${title}" can't be read.`, 'error');
    return;
  }
  const { project, view, file, handle, missingSamples } = restored;
  s.files.replace(project, view, { name: file.name, handle, fileKey: file.fileKey }, { dirty: true });
  try {
    // This tab's own crash copy must exist before the old one goes.
    await persistence.flush();
    await discardRecovery(meta);
  } catch (e) {
    console.warn('Keeping the old autosave; this session could not autosave yet:', e);
  }
  s.session.getState().toast(`Recovered "${file.name}". Save it to keep it.`);
  const missing = missingSoundsNotice(missingSamples ?? []);
  if (missing) s.session.getState().toast(missing, 'error');
}
