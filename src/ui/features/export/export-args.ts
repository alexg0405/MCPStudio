/** Reading the arguments of the "export now" commands (from the AI or a script) over the settings remembered from the last export. */
import type { Services } from '@app/services';
import { MP3_BITRATES, exportSettingsFrom, type AudioExportSettings } from '@app/export/audio-export';
import type { AudioCodec } from '@app/export/encode';
import type { ExportRange } from '@app/export/plan';
import type { PrefsState } from '@app/stores/prefs';
import { videoSettingsFrom, type VideoExportSettings } from '@app/export/video/video-export';
import { VIDEO_FORMATS, VIDEO_SIZES, VIDEO_STYLES } from '@core/video/formats';
import { songLength } from '@core/query/playlist';
import { ticksPerBar } from '@core/time/ppq';
import type { Tick } from '@core/model/types';

/** The sample rates an export can use, in Hz. */
const EXPORT_SAMPLE_RATES = [44100, 48000, 96000];

/** What `file.exportAudioNow` accepts (every field optional; the rest comes from the last export). */
export interface ExportArgs {
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

/** What `file.exportMp3` accepts: nothing for the whole song, or the bars to export. */
export interface Mp3Args {
  fromBar?: number;
  toBar?: number;
}

/** What `file.exportVideoNow` accepts (every field optional; the rest comes from the last video export). */
export interface VideoArgs {
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

/** The span of whole bars `{ fromBar, toBar }` names (1-based, both included), or null when either is missing or not a number. */
export function barsSpan(s: Services, args: { fromBar?: number; toBar?: number } | undefined): { from: Tick; to: Tick } | null {
  if (!args || !Number.isFinite(Number(args.fromBar)) || !Number.isFinite(Number(args.toBar))) return null;
  const ticksInBar = ticksPerBar(s.doc.getState().project.transport.timeSig);
  return { from: (Math.round(Number(args.fromBar)) - 1) * ticksInBar, to: Math.round(Number(args.toBar)) * ticksInBar };
}

/** Where the stems go when the arguments say zip or folder; the remembered choice when they say neither. */
function stemsDestination(zip: boolean | undefined, remembered: AudioExportSettings['stemsTo']): AudioExportSettings['stemsTo'] {
  if (zip === undefined) return remembered;
  return zip ? 'zip' : 'folder';
}

/** Settings for an export the AI (or a script) asked for: its args over the remembered ones. */
export function settingsFromArgs(s: Services, raw: unknown): AudioExportSettings {
  const args = (raw && typeof raw === 'object' ? raw : {}) as ExportArgs;
  const range: ExportRange = args.range === 'pattern' || args.range === 'loop' ? args.range : 'song';
  const base = exportSettingsFrom(s.prefs.getState(), range);
  const codec: AudioCodec = args.format === 'flac' || args.format === 'mp3' || args.format === 'wav' ? args.format : base.codec;
  const bits = Number(args.bits);
  return {
    ...base,
    codec,
    wavBits: bits === 16 || bits === 24 || bits === 32 ? bits : base.wavBits,
    flacBits: bits === 16 || bits === 24 ? bits : base.flacBits,
    mp3Kbps: (MP3_BITRATES as readonly number[]).includes(Number(args.kbps)) ? Number(args.kbps) : base.mp3Kbps,
    sampleRate: EXPORT_SAMPLE_RATES.includes(Number(args.sampleRate)) ? Number(args.sampleRate) : base.sampleRate,
    normalize: args.normalize ?? base.normalize,
    stems: args.stems ?? base.stems,
    masterChain: args.masterChain ?? base.masterChain,
    stemsTo: stemsDestination(args.zip, base.stemsTo),
  };
}

/** The range a video export covers when no bars are given: the loop or pattern if asked, else the song (or the pattern when the song is empty). */
function videoRangeFrom(songHasContent: boolean, asked: VideoArgs['range']): ExportRange {
  if (asked === 'pattern' || asked === 'loop') return asked;
  return songHasContent || asked === 'song' ? 'song' : 'pattern';
}

/** The title and artist text of a video: the arguments, else the project's own, else the file name. */
function videoText(s: Services, args: VideoArgs): { title: string; artist: string } {
  const project = s.doc.getState().project;
  const givenTitle = typeof args.title === 'string' && args.title.trim();
  const fileName = s.files.store.getState().name.replace(/\.agproj$/i, '');
  return {
    title: givenTitle || project.meta.title?.trim() || fileName || 'Untitled',
    artist: typeof args.artist === 'string' ? args.artist.trim() : (project.meta.author?.trim() ?? ''),
  };
}

/** Settings for a video the AI (or a script) asked for: its args over the remembered ones. */
export function videoSettingsFromArgs(s: Services, raw: unknown): VideoExportSettings {
  const args = (raw && typeof raw === 'object' ? raw : {}) as VideoArgs;
  const project = s.doc.getState().project;
  const range: ExportRange = barsSpan(s, args) ?? videoRangeFrom(songLength(project) > 0, args.range);
  const base = videoSettingsFrom(s.prefs.getState(), range, videoText(s, args));
  return {
    ...base,
    style: (VIDEO_STYLES as readonly string[]).includes(args.style ?? '') ? (args.style as VideoExportSettings['style']) : base.style,
    size: (VIDEO_SIZES as readonly string[]).includes(args.size ?? '') ? (args.size as VideoExportSettings['size']) : base.size,
    fps: args.fps === 30 || args.fps === 60 ? args.fps : base.fps,
    format: (VIDEO_FORMATS as readonly string[]).includes(args.format ?? '') ? (args.format as VideoExportSettings['format']) : base.format,
    normalize: args.normalize ?? base.normalize,
  };
}

/** The WAV bit depth as the prefs store it. */
function wavFormatPref(wavBits: number): PrefsState['exportFormat'] {
  if (wavBits === 16) return 'pcm16';
  if (wavBits === 32) return 'float32';
  return 'pcm24';
}

/** Remembers what was used, so the dialog opens with it next time. */
export function rememberAudioSettings(s: Services, used: AudioExportSettings): void {
  const patch: Partial<PrefsState> = {
    exportCodec: used.codec,
    exportFlacBits: used.flacBits,
    exportMp3Kbps: used.mp3Kbps,
    exportSampleRate: used.sampleRate,
    exportNormalize: used.normalize,
    exportStems: used.stems,
    exportMasterChain: used.masterChain,
    exportStemsTo: used.stemsTo,
    exportFormat: wavFormatPref(used.wavBits),
  };
  s.prefs.getState().set(patch);
}
