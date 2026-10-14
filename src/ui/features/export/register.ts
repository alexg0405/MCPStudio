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
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { ExportOverlay, exportStore } from './ExportDialog';

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
    run: () => exportStore.setState({ open: true }),
  });
  services.commands.register({
    id: 'file.exportStems',
    title: 'Export stems…',
    category: 'File',
    hint: 'One audio file per mixer track that plays something, all the same length, into a folder or a .zip',
    enabled: idle,
    run: (s) => {
      s.prefs.getState().set({ exportStems: true });
      exportStore.setState({ open: true });
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
  services.keymap.add([{ chord: 'Mod+R', command: 'file.exportWav' }]);
  addMenuItems('file', [sep(60), cmd('file.exportWav', 70), cmd('file.exportStems', 71)]);
  addOverlay('export-wav', ExportOverlay);
}
