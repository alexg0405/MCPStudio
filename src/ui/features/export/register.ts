import type { Services } from '@app/services';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { ExportOverlay, exportStore } from './ExportDialog';

/** File > Export WAV (Mod+R). */
export function register(services: Services): void {
  services.commands.register({
    id: 'file.exportWav',
    title: 'Export WAV…',
    category: 'File',
    hint: 'Render the song, the current pattern or the loop region to a WAV file',
    enabled: (s) => s.files.store.getState().busy === null,
    run: () => exportStore.setState({ open: true }),
  });
  services.keymap.add([{ chord: 'Mod+R', command: 'file.exportWav' }]);
  addMenuItems('file', [sep(60), cmd('file.exportWav', 70)]);
  addOverlay('export-wav', ExportOverlay);
}
