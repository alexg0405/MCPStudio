import type { Services } from '@app/services';
import { setVideoThemeProvider } from '@app/export/video/video-export';
import { songSections } from '@core/query/sections';
import { barSpan } from '@core/time/bars';
import type { Tick } from '@core/model/types';
import { addContextMenuItems } from '../../context-menus';
import type { MenuEntry } from '../../controls/ContextMenu';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { ExportOverlay } from './ExportDialog';
import { exportAudioNow, exportMp3, exportVideoNow } from './export-now';
import { openExport } from './export-store';
import { videoThemeOf } from './video-preview';
import { readTheme } from '../../timeline/canvas';
import type { ExportArgs, Mp3Args, VideoArgs } from './export-args';

/** Whether no project operation (open, save, new) is running, so an export can start. */
const idle = (s: Services) => s.files.store.getState().busy === null;

/** "Export bars 5–8 as MP3" for a part of the song (a section, the loop, a clip's bars). */
function partItem(s: Services, from: Tick, to: Tick, what?: string): MenuEntry {
  const bars = barSpan(from, to, s.doc.getState().project.transport.timeSig);
  return {
    label: `Export ${what ?? bars} as MP3`,
    hint: `Render ${what ? `${what} (${bars})` : bars} with every track playing there to an MP3 (asks where to save)`,
    disabled: s.files.store.getState().busy !== null,
    onSelect: () => void exportMp3(s, { from, to }),
  };
}

/** "Export bars 5–8 as video…" for a part of the song (a section, the loop, a clip's bars): opens the dialog on it. */
function partVideoItem(s: Services, from: Tick, to: Tick, what?: string): MenuEntry {
  const bars = barSpan(from, to, s.doc.getState().project.transport.timeSig);
  return {
    label: `Export ${what ?? bars} as video…`,
    hint: `Make a music video of ${what ? `${what} (${bars})` : bars}: pick the look and the file type, then it is rendered`,
    disabled: s.files.store.getState().busy !== null,
    onSelect: () => openExport('video', { from, to, label: what ? `${what} (${bars})` : bars }),
  };
}

/** File > Export audio (Mod+R), Export stems, an export that runs right away (for the AI) and the right-click entries that export a part as MP3 or video. */
export function register(services: Services): void {
  registerExportCommands(services);
  registerExportKeysAndMenus(services);
  registerPartMenus();
  addOverlay('export-wav', ExportOverlay);
}

/** The export commands: the dialog (audio, video, stems), and the ones that run right away. */
function registerExportCommands(services: Services): void {
  services.commands.register({
    id: 'file.exportWav',
    title: 'Export audio…',
    category: 'File',
    hint: 'Render the song, the current pattern or the loop region to a WAV, FLAC or MP3 file, or as stems',
    enabled: idle,
    run: () => openExport('audio'),
  });
  services.commands.register({
    id: 'file.exportVideo',
    title: 'Export as video…',
    category: 'File',
    hint: 'Make a music video of the song, the current pattern, the loop or a section: spectrum bars, a waveform, a circle or a minimal look with your title and cover picture, as an MP4 or WebM file',
    enabled: idle,
    run: () => openExport('video'),
  });
  services.commands.register({
    id: 'file.exportStems',
    title: 'Export stems…',
    category: 'File',
    hint: 'One audio file per mixer track that plays something, all the same length, into a folder or a .zip',
    enabled: idle,
    run: (s) => {
      s.prefs.getState().set({ exportStems: true });
      openExport('audio');
    },
  });
  services.commands.register<ExportArgs>({
    id: 'file.exportAudioNow',
    title: 'Export audio now',
    category: 'File',
    hint: 'Exports straight away with the given settings (the last ones otherwise): asks where to save, then renders',
    gesture: true,
    argsHint:
      "optional object: { range: 'song' | 'pattern' | 'loop', format: 'wav' | 'flac' | 'mp3', bits: 16 | 24 | 32, kbps: 128 | 192 | 256 | 320, sampleRate: 44100 | 48000 | 96000, normalize: boolean, stems: boolean, masterChain: boolean, zip: boolean }",
    palette: false,
    enabled: idle,
    run: (s, args) => exportAudioNow(s, args),
  });
  services.commands.register<VideoArgs>({
    id: 'file.exportVideoNow',
    title: 'Export video now',
    category: 'File',
    hint: 'Makes a music video straight away with the given settings (the last ones otherwise): asks where to save, then renders the audio and draws the pictures',
    gesture: true,
    argsHint:
      "optional object: { range: 'song' | 'pattern' | 'loop', fromBar, toBar (1-based, both included; export just those bars), style: 'bars' | 'wave' | 'circle' | 'minimal', size: '1080p' | 'vertical' | 'square', fps: 30 | 60, format: 'mp4-h264' | 'webm-vp9' | 'webm-av1', title, artist, normalize: boolean }",
    palette: false,
    enabled: idle,
    run: (s, args) => exportVideoNow(s, args),
  });
  services.commands.register<Mp3Args>({
    id: 'file.exportMp3',
    title: 'Export as MP3',
    category: 'File',
    hint: 'One click: asks where to save, then renders the whole song (or the current pattern when the playlist is empty) to an MP3 at your last MP3 quality (320 kbps at first)',
    argsHint: 'optional { fromBar, toBar } (1-based, both included) to export just those bars',
    gesture: true,
    enabled: idle,
    run: (s, args) => exportMp3(s, args),
  });
}

/** The Mod+R key, the File menu entries and the video theme provider. */
function registerExportKeysAndMenus(services: Services): void {
  services.keymap.add([{ chord: 'Mod+R', command: 'file.exportWav' }]);
  addMenuItems('file', [
    sep(60),
    cmd('file.exportMp3', 69),
    cmd('file.exportWav', 70),
    cmd('file.exportStems', 71),
    cmd('file.exportVideo', 72),
  ]);
  setVideoThemeProvider(() => videoThemeOf(readTheme()));
}

/** Right-click a section, the loop or a clip: export just that part as an MP3 or a video. */
function registerPartMenus(): void {
  // Right-click: just this part as an MP3.
  addContextMenuItems('playlist.marker', ({ markerId }, s) => {
    const sec = songSections(s.doc.getState().project).find((x) => x.markerId === markerId);
    return sec ? [partItem(s, sec.from, sec.to, `“${sec.name}”`), partVideoItem(s, sec.from, sec.to, `“${sec.name}”`)] : [];
  });
  addContextMenuItems('playlist.ruler', (_ctx, s) => {
    const loop = s.view.getState().loop;
    return loop && loop.end > loop.start
      ? [partItem(s, loop.start, loop.end, 'the loop'), partVideoItem(s, loop.start, loop.end, 'the loop')]
      : [];
  });
  addContextMenuItems('playlist.clip', ({ clip }, s) => [
    partItem(s, clip.start, clip.start + clip.length),
    partVideoItem(s, clip.start, clip.start + clip.length),
  ]);
}
