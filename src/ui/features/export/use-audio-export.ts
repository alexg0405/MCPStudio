import { useState, type MutableRefObject } from 'react';
import { useStore } from 'zustand';
import { chooseExportTarget, runExport, type AudioExportSettings } from '@app/export/audio-export';
import { ExportError, type ExportProgress } from '@app/export/export-wav';
import { useServices } from '../../services-context';
import { exportStore } from './export-store';
import { formatTime } from './export-text';

/** How far an export has come, with the name of the stem or step being worked on. */
export type RunningExport = ExportProgress & { label?: string };

/**
 * Runs the audio export for the dialog: asks where to save, renders and writes, and keeps the progress and the last
 * error to show. `abortRef` is shared with the dialog so Esc and Cancel can stop a running export.
 */
export function useAudioExport(settings: AudioExportSettings, abortRef: MutableRefObject<AbortController | null>) {
  const services = useServices();
  const projectName = useStore(services.files.store, (f) => f.name);
  const [progress, setProgress] = useState<RunningExport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const closeDialog = () => exportStore.setState({ open: false });

  const start = async () => {
    setError(null);
    let target;
    try {
      // The click on Export is the user gesture the save or folder picker needs, so ask first.
      target = await chooseExportTarget(projectName, settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!target) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ stage: 'render', fraction: 0 });
    try {
      const result = await runExport(services, settings, target, { signal: controller.signal, onProgress: setProgress });
      const time = formatTime(result.seconds);
      const message =
        result.names.length > 1
          ? `Exported ${result.names.length} stems (${time}) to “${target.name}”`
          : `Exported “${target.name}” (${time})`;
      services.session.getState().toast(message);
      closeDialog();
    } catch (e) {
      if (controller.signal.aborted) {
        services.session.getState().toast('Export cancelled');
        closeDialog();
        return;
      }
      console.error('Export failed', e);
      setError(e instanceof ExportError || e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  };

  return { progress, error, start };
}
