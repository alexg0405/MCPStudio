import { useEffect, useRef, useState } from 'react';
import { createStore, useStore } from 'zustand';
import {
  ExportError,
  WAV_FORMATS,
  chooseWavTarget,
  renderWav,
  writeWav,
  type ExportProgress,
  type WavFormat,
} from '@app/export/export-wav';
import { planExport, type ExportRange } from '@app/export/plan';
import { holdModal } from '../../controls/Dialog';
import { useDoc, useServices, useView } from '../../services-context';
import dialog from '../../controls/Dialog.module.css';
import styles from './ExportDialog.module.css';

export const exportStore = createStore<{ open: boolean }>(() => ({ open: false }));

const RATES = [44100, 48000, 96000];

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Overlay host: renders the dialog while the export command has it open. */
export function ExportOverlay() {
  const open = useStore(exportStore, (s) => s.open);
  return open ? <ExportDialog /> : null;
}

function ExportDialog() {
  const services = useServices();
  const project = useDoc((p) => p);
  const view = useView((v) => v);
  const name = useStore(services.files.store, (f) => f.name);
  const prefs = useStore(services.prefs);
  const songRange = planExport(project, view, 'song');
  const [range, setRange] = useState<ExportRange>(() => (!('error' in songRange) ? 'song' : 'pattern'));
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const close = () => {
    abort.current?.abort();
    exportStore.setState({ open: false });
  };

  useEffect(() => {
    const release = holdModal();
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (abort.current) abort.current.abort();
      else exportStore.setState({ open: false });
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      release();
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const describe = (r: ExportRange) => {
    const plan = planExport(project, view, r);
    if ('error' in plan) return null;
    const ts = project.transport.timeSig;
    const seconds = (plan.bars * ts.num * 4 * 60) / (ts.den * project.transport.bpm);
    const bars = Math.round(plan.bars * 100) / 100;
    return `${bars} bar${bars === 1 ? '' : 's'}, ${formatTime(seconds)}`;
  };
  const ranges: { value: ExportRange; label: string }[] = [
    { value: 'song', label: 'Song' },
    {
      value: 'pattern',
      label: `Pattern: ${view.currentPatternId ? project.patterns[view.currentPatternId]?.name : '—'}`,
    },
    { value: 'loop', label: 'Loop region' },
  ];

  const start = async () => {
    setError(null);
    let target;
    try {
      // The click on Export is the user gesture the save picker needs, so ask first.
      target = await chooseWavTarget(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!target) return;
    const controller = new AbortController();
    abort.current = controller;
    setProgress({ stage: 'render', fraction: 0 });
    try {
      const { bytes, seconds } = await renderWav(
        services,
        { range, format: prefs.exportFormat, sampleRate: prefs.exportSampleRate },
        { signal: controller.signal, onProgress: setProgress },
      );
      await writeWav(target, bytes);
      services.session.getState().toast(`Exported "${target.name}" (${formatTime(seconds)})`);
      exportStore.setState({ open: false });
    } catch (e) {
      if (controller.signal.aborted) {
        services.session.getState().toast('Export cancelled');
        exportStore.setState({ open: false });
        return;
      }
      console.error('Export failed', e);
      setError(e instanceof ExportError || e instanceof Error ? e.message : String(e));
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };

  const busy = progress !== null;
  const plan = planExport(project, view, range);
  return (
    <div className={dialog.backdrop}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`${dialog.dialog} ${styles.export}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-export-title"
      >
        <h2 id="ag-export-title" className={dialog.title}>
          Export WAV
        </h2>
        <fieldset className={styles.group} disabled={busy}>
          <legend>Range</legend>
          {ranges.map((r) => {
            const info = describe(r.value);
            return (
              <label key={r.value} className={`${styles.option} ${info ? '' : styles.optionOff}`}>
                <input
                  type="radio"
                  name="range"
                  checked={range === r.value}
                  disabled={!info}
                  onChange={() => setRange(r.value)}
                />
                <span>{r.label}</span>
                <span className={styles.meta}>{info ?? 'not available'}</span>
              </label>
            );
          })}
        </fieldset>
        <div className={styles.row}>
          <label className={styles.field}>
            Format
            <select
              value={prefs.exportFormat}
              disabled={busy}
              onChange={(e) => services.prefs.getState().set({ exportFormat: e.target.value as WavFormat })}
            >
              {WAV_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Sample rate
            <select
              value={prefs.exportSampleRate}
              disabled={busy}
              onChange={(e) => services.prefs.getState().set({ exportSampleRate: Number(e.target.value) })}
            >
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r / 1000} kHz
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className={dialog.detail}>
          Renders with the same engine as playback, including release and effect tails; the silence after the last tail
          is trimmed.
        </p>
        {busy && (
          <div className={styles.progress} role="progressbar" aria-valuenow={Math.round(progress.fraction * 100)}>
            <div className={styles.bar} style={{ width: `${progress.fraction * 100}%` }} />
            <span>
              {progress.stage === 'render' ? 'Rendering' : 'Encoding'}… {Math.round(progress.fraction * 100)}%
            </span>
          </div>
        )}
        {error && <p className={styles.error}>{error}</p>}
        <div className={dialog.buttons}>
          <button className={dialog.button} onClick={close}>
            Cancel
          </button>
          {!busy && (
            <button
              className={`${dialog.button} ${dialog.primary}`}
              disabled={'error' in plan}
              onClick={() => void start()}
            >
              Export…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
