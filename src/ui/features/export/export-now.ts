/** The exports that run without the dialog: ask where to save, render, and say how it went in a toast. */
import type { Services } from '@app/services';
import { chooseExportTarget, exportSettingsFrom, runExport, type AudioExportSettings } from '@app/export/audio-export';
import type { ExportRange } from '@app/export/plan';
import { chooseVideoTarget, runVideoExport, videoPrefsPatch } from '@app/export/video/video-export';
import { songLength } from '@core/query/playlist';
import { barSpan } from '@core/time/bars';
import type { Tick } from '@core/model/types';
import { barsSpan, rememberAudioSettings, settingsFromArgs, videoSettingsFromArgs, type ExportArgs, type Mp3Args, type VideoArgs } from './export-args';

/** Shows the error of a failed export as a toast. */
function toastFailure(s: Services, e: unknown): void {
  s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
}

/**
 * Export as MP3: the remembered MP3 quality, the mix through the master, no stems; asks where to
 * save, then renders with a toast for the start and the end. `from`/`to`: just that part of the song.
 */
export async function exportMp3(s: Services, args?: Mp3Args | { from: Tick; to: Tick; label?: string }): Promise<void> {
  const project = s.doc.getState().project;
  const span = args && 'from' in args ? { from: args.from, to: args.to } : barsSpan(s, args);
  const range: ExportRange = span ?? (songLength(project) > 0 ? 'song' : 'pattern');
  const settings: AudioExportSettings = { ...exportSettingsFrom(s.prefs.getState(), range), codec: 'mp3', stems: false, masterChain: true };
  const baseName = s.files.store.getState().name;
  const partNote = span ? ` (${barSpan(span.from, span.to, project.transport.timeSig)})` : '';
  const target = await chooseExportTarget(`${baseName}${partNote}`, settings);
  if (!target) return;
  const toast = s.session.getState().toast;
  toast(`Exporting “${target.name}”…`);
  try {
    await runExport(s, settings, target);
    toast(`Exported “${target.name}”`);
  } catch (e) {
    toastFailure(s, e);
  }
}

/** `file.exportAudioNow`: exports straight away with the given settings (the last ones otherwise). */
export async function exportAudioNow(s: Services, args: ExportArgs | undefined): Promise<void> {
  const settings = settingsFromArgs(s, args);
  rememberAudioSettings(s, settings);
  const target = await chooseExportTarget(s.files.store.getState().name, settings);
  if (!target) return;
  s.session.getState().toast(settings.stems ? 'Exporting stems…' : `Exporting ${settings.codec.toUpperCase()}…`);
  try {
    const result = await runExport(s, settings, target);
    const message = result.names.length > 1 ? `Exported ${result.names.length} stems to “${target.name}”` : `Exported “${target.name}”`;
    s.session.getState().toast(message);
  } catch (e) {
    toastFailure(s, e);
  }
}

/** `file.exportVideoNow`: makes a music video straight away with the given settings (the last ones otherwise). */
export async function exportVideoNow(s: Services, args: VideoArgs | undefined): Promise<void> {
  const settings = videoSettingsFromArgs(s, args);
  const target = await chooseVideoTarget(settings.title, settings.format);
  if (!target) return;
  s.prefs.getState().set(videoPrefsPatch(settings));
  const toast = s.session.getState().toast;
  toast(`Making the video “${target.name}”…`);
  try {
    const result = await runVideoExport(s, settings, target);
    toast(`Exported “${target.name}” (${Math.round(result.seconds)} s, made in ${Math.round(result.took)} s)`);
  } catch (e) {
    toastFailure(s, e);
  }
}
