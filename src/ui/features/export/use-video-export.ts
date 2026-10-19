import { useState, type MutableRefObject } from 'react';
import { ExportError } from '@app/export/export-wav';
import { chooseVideoTarget, runVideoExport, videoPrefsPatch, type VideoExportSettings } from '@app/export/video/video-export';
import { useServices } from '../../services-context';
import { formatTime, megabytes } from './export-text';
import type { RunningExport } from './use-audio-export';

interface VideoExportInput {
  /** The settings as the panel shows them now (read when Export is pressed). */
  currentSettings(): VideoExportSettings;
  /** The name the save dialog starts with. */
  fileTitle: string;
  /** Tells the dialog an export is running (its tabs and range lock). */
  onBusy(busy: boolean): void;
  /** Shared with the dialog, so Esc and Cancel can stop the export. */
  abortRef: MutableRefObject<AbortController | null>;
  onClose(): void;
}

/**
 * Runs the video export for the panel: asks where to save, renders and draws, and keeps the progress and the last
 * error to show. The choices made are remembered in the prefs once the save dialog is answered.
 */
export function useVideoExport({ currentSettings, fileTitle, onBusy, abortRef, onClose }: VideoExportInput) {
  const services = useServices();
  const [progress, setProgress] = useState<RunningExport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    const settings = currentSettings();
    let target;
    try {
      // The click on Export is the user gesture the save dialog needs, so ask first.
      target = await chooseVideoTarget(fileTitle, settings.format);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!target) return;
    services.prefs.getState().set(videoPrefsPatch(settings));
    const controller = new AbortController();
    abortRef.current = controller;
    onBusy(true);
    setProgress({ stage: 'render', fraction: 0 });
    try {
      const result = await runVideoExport(services, settings, target, { signal: controller.signal, onProgress: setProgress });
      const length = formatTime(result.seconds);
      const took = formatTime(result.took);
      services.session.getState().toast(`Exported “${target.name}” (${length}, ${megabytes(result.bytes)}, made in ${took})`);
      onClose();
    } catch (e) {
      if (controller.signal.aborted) {
        services.session.getState().toast('Export cancelled');
        onClose();
        return;
      }
      console.error('Video export failed', e);
      setError(e instanceof ExportError || e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
      onBusy(false);
      setProgress(null);
    }
  };

  return { progress, error, start };
}
