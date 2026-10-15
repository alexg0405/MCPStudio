/** "Make the mix" from the UI: asks where (the playlist has other music), makes it, shows it. */
import { makeLibraryMix } from '@app/dj/library';
import { hasOtherMusic } from '@app/dj/mix';
import type { Services } from '@app/services';
import type { DjMixOptions } from '@core/model/types';
import { showDialog } from '../../controls/Dialog';
import { openWindow } from '../../workspace/registry';

export async function makeMixFromUi(s: Services, options: DjMixOptions): Promise<void> {
  const toast = s.session.getState().toast;
  if (hasOtherMusic(s.doc.getState().project)) {
    const choice = await showDialog({
      title: 'Where should the mix go?',
      message: 'This project already has music on the playlist. The mix starts at bar 1 and would play on top of it.',
      detail: 'A new project keeps your song as it is (you are asked to save it first).',
      buttons: [
        { id: 'new', label: 'New project for the mix', primary: true },
        { id: 'here', label: 'Put it in this project' },
        { id: 'cancel', label: 'Cancel' },
      ],
      cancelId: 'cancel',
    });
    if (choice === 'cancel') return;
    if (choice === 'new' && !(await s.files.newProject())) return;
  }
  try {
    const res = await makeLibraryMix(s, options);
    if (!res) return;
    openWindow(s, 'playlist');
    // The whole mix in view (about 1000 px wide), from bar 1.
    if (res.plan.totalTicks > 0) s.editor.getState().setPlaylist({ scrollTick: 0, pxPerTick: Math.min(s.editor.getState().playlist.pxPerTick, 1000 / res.plan.totalTicks) });
    const min = Math.round(res.plan.durationSec / 60);
    toast(`Made a ${res.plan.songs.length}-song mix (${min} min). Press Space to play it; tweak transitions in the DJ window.`);
    for (const w of res.warnings.slice(0, 2)) toast(w, 'error');
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return toast('Stopped making the mix.');
    toast(e instanceof Error ? e.message : String(e), 'error');
  }
}
