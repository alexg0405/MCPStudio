import type { Services } from '@app/services';
import {
  MP3_BITRATES,
  chooseExportTarget,
  exportSettingsFrom,
  runExport,
  type AudioExportSettings,
} from '@app/export/audio-export';
import type { AudioCodec } from '@app/export/encode';
import type { ExportRange } from '@app/export/plan';
import type { PrefsState } from '@app/stores/prefs';
import {
  chooseVideoTarget,
  setVideoThemeProvider,
  videoPrefsPatch,
  videoSettingsFrom,
  runVideoExport,
  type VideoExportSettings,
} from '@app/export/video/video-export';
import { VIDEO_FORMATS, VIDEO_SIZES, VIDEO_STYLES } from '@core/video/formats';
import { songSections } from '@core/query/sections';
import { songLength } from '@core/query/playlist';
import { barSpan } from '@core/time/bars';
import { ticksPerBar } from '@core/time/ppq';
import type { Tick } from '@core/model/types';
import { addContextMenuItems } from '../../context-menus';
import type { MenuEntry } from '../../controls/ContextMenu';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { ExportOverlay } from './ExportDialog';
import { openExport } from './export-store';
import { videoThemeOf } from './video-preview';
import { readTheme } from '../../timeline/canvas';

/** What `file.exportAudioNow` accepts (every field optional; the rest comes from the last export). */
interface ExportArgs {
  range?: ExportRange;
  format?: AudioCodec;
  bits?: number;
  kbps?: number;
  sampleRate?: number;
  normalize?: boolean;
  stems?: boolean;
  masterChain?: boolean;
  zip?: boolean;
}

/** Settings for an export the AI (or a script) asked for: its args over the remembered ones. */
function settingsFromArgs(s: Services, raw: unknown): AudioExportSettings {
  const a = (raw && typeof raw === 'object' ? raw : {}) as ExportArgs;
  const range: ExportRange = a.range === 'pattern' || a.range === 'loop' ? a.range : 'song';
  const base = exportSettingsFrom(s.prefs.getState(), range);
  const codec: AudioCodec = a.format === 'flac' || a.format === 'mp3' || a.format === 'wav' ? a.format : base.codec;
  const bits = Number(a.bits);
  return {
    ...base,
    codec,
    wavBits: bits === 16 || bits === 24 || bits === 32 ? bits : base.wavBits,
    flacBits: bits === 16 || bits === 24 ? bits : base.flacBits,
    mp3Kbps: (MP3_BITRATES as readonly number[]).includes(Number(a.kbps)) ? Number(a.kbps) : base.mp3Kbps,
    sampleRate: [44100, 48000, 96000].includes(Number(a.sampleRate)) ? Number(a.sampleRate) : base.sampleRate,
    normalize: a.normalize ?? base.normalize,
    stems: a.stems ?? base.stems,
    masterChain: a.masterChain ?? base.masterChain,
    stemsTo: a.zip === undefined ? base.stemsTo : a.zip ? 'zip' : 'folder',
  };
}

/** What `file.exportMp3` accepts: nothing for the whole song, or the bars to export. */
interface Mp3Args {
  fromBar?: number;
  toBar?: number;
}

/**
 * Export as MP3: the remembered MP3 quality, the mix through the master, no stems; asks where to
 * save, then renders with a toast for the start and the end. `from`/`to`: just that part of the song.
 */
async function exportMp3(s: Services, args?: Mp3Args | { from: Tick; to: Tick; label?: string }): Promise<void> {
  const p = s.doc.getState().project;
  const bar = ticksPerBar(p.transport.timeSig);
  let span: { from: Tick; to: Tick } | null = null;
  if (args && 'from' in args) span = { from: args.from, to: args.to };
  else if (args && Number.isFinite(Number(args.fromBar)) && Number.isFinite(Number(args.toBar)))
    span = { from: (Math.round(Number(args.fromBar)) - 1) * bar, to: Math.round(Number(args.toBar)) * bar };
  const range: ExportRange = span ?? (songLength(p) > 0 ? 'song' : 'pattern');
  const settings: AudioExportSettings = { ...exportSettingsFrom(s.prefs.getState(), range), codec: 'mp3', stems: false, masterChain: true };
  const base = s.files.store.getState().name;
  const part = span ? ` (${barSpan(span.from, span.to, p.transport.timeSig)})` : '';
  const target = await chooseExportTarget(`${base}${part}`, settings);
  if (!target) return;
  const toast = s.session.getState().toast;
  toast(`Exporting “${target.name}”…`);
  try {
    await runExport(s, settings, target);
    toast(`Exported “${target.name}”`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  }
}

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

/** What `file.exportVideoNow` accepts (every field optional; the rest comes from the last video export). */
interface VideoArgs {
  range?: 'song' | 'pattern' | 'loop';
  fromBar?: number;
  toBar?: number;
  style?: string;
  size?: string;
  fps?: number;
  format?: string;
  title?: string;
  artist?: string;
  normalize?: boolean;
}

/** Settings for a video the AI (or a script) asked for: its args over the remembered ones. */
function videoSettingsFromArgs(s: Services, raw: unknown): VideoExportSettings {
  const a = (raw && typeof raw === 'object' ? raw : {}) as VideoArgs;
  const p = s.doc.getState().project;
  const bar = ticksPerBar(p.transport.timeSig);
  let range: ExportRange =
    a.range === 'pattern' || a.range === 'loop' ? a.range : songLength(p) > 0 || a.range === 'song' ? 'song' : 'pattern';
  if (Number.isFinite(Number(a.fromBar)) && Number.isFinite(Number(a.toBar)))
    range = { from: (Math.round(Number(a.fromBar)) - 1) * bar, to: Math.round(Number(a.toBar)) * bar };
  const text = {
    title:
      (typeof a.title === 'string' && a.title.trim()) ||
      p.meta.title?.trim() ||
      s.files.store.getState().name.replace(/\.agproj$/i, '') ||
      'Untitled',
    artist: typeof a.artist === 'string' ? a.artist.trim() : (p.meta.author?.trim() ?? ''),
  };
  const base = videoSettingsFrom(s.prefs.getState(), range, text);
  return {
    ...base,
    style: (VIDEO_STYLES as readonly string[]).includes(a.style ?? '') ? (a.style as VideoExportSettings['style']) : base.style,
    size: (VIDEO_SIZES as readonly string[]).includes(a.size ?? '') ? (a.size as VideoExportSettings['size']) : base.size,
    fps: a.fps === 30 || a.fps === 60 ? a.fps : base.fps,
    format: (VIDEO_FORMATS as readonly string[]).includes(a.format ?? '') ? (a.format as VideoExportSettings['format']) : base.format,
    normalize: a.normalize ?? base.normalize,
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

/** Remembers what was used, so the dialog opens with it next time. */
function remember(s: Services, x: AudioExportSettings): void {
  const patch: Partial<PrefsState> = {
    exportCodec: x.codec,
    exportFlacBits: x.flacBits,
    exportMp3Kbps: x.mp3Kbps,
    exportSampleRate: x.sampleRate,
    exportNormalize: x.normalize,
    exportStems: x.stems,
    exportMasterChain: x.masterChain,
    exportStemsTo: x.stemsTo,
    exportFormat: x.wavBits === 16 ? 'pcm16' : x.wavBits === 32 ? 'float32' : 'pcm24',
  };
  s.prefs.getState().set(patch);
}

/** File > Export audio (Mod+R), Export stems, and an export that runs right away (for the AI). */
export function register(services: Services): void {
  const idle = (s: Services) => s.files.store.getState().busy === null;
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
    run: async (s, args) => {
      const settings = settingsFromArgs(s, args);
      remember(s, settings);
      const target = await chooseExportTarget(s.files.store.getState().name, settings);
      if (!target) return;
      s.session.getState().toast(settings.stems ? 'Exporting stems…' : `Exporting ${settings.codec.toUpperCase()}…`);
      try {
        const res = await runExport(s, settings, target);
        s.session
          .getState()
          .toast(res.names.length > 1 ? `Exported ${res.names.length} stems to “${target.name}”` : `Exported “${target.name}”`);
      } catch (e) {
        s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
      }
    },
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
    run: async (s, args) => {
      const settings = videoSettingsFromArgs(s, args);
      const target = await chooseVideoTarget(settings.title, settings.format);
      if (!target) return;
      s.prefs.getState().set(videoPrefsPatch(settings));
      const toast = s.session.getState().toast;
      toast(`Making the video “${target.name}”…`);
      try {
        const res = await runVideoExport(s, settings, target);
        toast(`Exported “${target.name}” (${Math.round(res.seconds)} s, made in ${Math.round(res.took)} s)`);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
      }
    },
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
  services.keymap.add([{ chord: 'Mod+R', command: 'file.exportWav' }]);
  addMenuItems('file', [
    sep(60),
    cmd('file.exportMp3', 69),
    cmd('file.exportWav', 70),
    cmd('file.exportStems', 71),
    cmd('file.exportVideo', 72),
  ]);
  setVideoThemeProvider(() => videoThemeOf(readTheme()));
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
  addOverlay('export-wav', ExportOverlay);
}
