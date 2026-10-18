import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  MP3_BITRATES,
  chooseExportTarget,
  effectiveRate,
  exportSettingsFrom,
  runExport,
} from '@app/export/audio-export';
import { MP3_SAMPLE_RATES, type AudioCodec } from '@app/export/encode';
import { ExportError, type ExportProgress } from '@app/export/export-wav';
import { planExport, planSeconds, type ExportRange, type NamedExportRange } from '@app/export/plan';
import type { PrefsState } from '@app/stores/prefs';
import { planStems, withoutMasterChain } from '@core/query/stems';
import { ticksPerBar } from '@core/time/ppq';
import { holdModal } from '../../controls/Dialog';
import { useDoc, useServices, useView } from '../../services-context';
import dialog from '../../controls/Dialog.module.css';
import { exportStore } from './export-store';
import { VideoPanel } from './VideoPanel';
import styles from './ExportDialog.module.css';

const RATES = [44100, 48000, 96000];

const CODECS: { value: AudioCodec; label: string; note: string }[] = [
  {
    value: 'wav',
    label: 'WAV',
    note: 'Uncompressed: exactly what AGstudio rendered. Every app and DAW reads it; the biggest files.',
  },
  {
    value: 'flac',
    label: 'FLAC',
    note: 'Lossless like WAV (nothing is lost) at about half the size. Most players and DAWs read it.',
  },
  {
    value: 'mp3',
    label: 'MP3',
    note: 'Small files for sharing and phones. Some detail is lost; 320 kbps sounds closest to the original.',
  },
];

const WAV_DEPTHS: { value: PrefsState['exportFormat']; label: string; hint: string }[] = [
  { value: 'pcm16', label: '16-bit', hint: 'CD quality, with dither (a tiny noise that hides rounding)' },
  { value: 'pcm24', label: '24-bit', hint: 'Studio quality: more detail in quiet parts' },
  { value: 'float32', label: '32-bit float', hint: 'Never clips, even above 0 dB: best for mixing elsewhere' },
];

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
  const set = (patch: Partial<PrefsState>) => services.prefs.getState().set(patch);
  const tab = useStore(exportStore, (e) => e.tab);
  const span = useStore(exportStore, (e) => e.span);
  const songRange = planExport(project, view, 'song');
  /** What the Range section shows as chosen: a named range, or the span the dialog was opened for. */
  const [choice, setChoice] = useState<NamedExportRange | 'span'>(() =>
    span ? 'span' : !('error' in songRange) ? 'song' : 'pattern',
  );
  const range: ExportRange =
    choice === 'span' && span ? { from: span.from, to: span.to } : choice === 'span' ? 'song' : choice;
  const [videoBusy, setVideoBusy] = useState(false);
  const [progress, setProgress] = useState<(ExportProgress & { label?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const settings = exportSettingsFrom(prefs, range);

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
    const seconds = planSeconds(project, plan);
    const bars = Math.round(plan.bars * 100) / 100;
    return `${bars} bar${bars === 1 ? '' : 's'}, ${formatTime(seconds)}`;
  };
  const ranges: { value: NamedExportRange | 'span'; label: string; hint: string }[] = [
    ...(span
      ? [{ value: 'span' as const, label: span.label, hint: `Only ${span.label}, with every track playing there` }]
      : []),
    { value: 'song', label: 'Song', hint: 'The whole playlist, from bar 1 to the end of the last clip' },
    {
      value: 'pattern',
      label: `Pattern: ${view.currentPatternId ? project.patterns[view.currentPatternId]?.name : '—'}`,
      hint: 'Only the current pattern, once',
    },
    { value: 'loop', label: 'Loop region', hint: 'The range selected on the playlist ruler' },
  ];
  const rangeOf = (c: NamedExportRange | 'span'): ExportRange =>
    c === 'span' ? (span ? { from: span.from, to: span.to } : 'song') : c;

  const plan = planExport(project, view, range);
  const stems = useMemo(() => {
    if ('error' in plan) return [];
    const base = prefs.exportMasterChain ? project : withoutMasterChain(project);
    const toTick = plan.fromTick + plan.bars * ticksPerBar(project.transport.timeSig);
    return planStems(base, { mode: plan.mode, patternId: plan.patternId, fromTick: plan.fromTick, toTick });
    // `plan` is derived from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, view, range, prefs.exportMasterChain]);

  const start = async () => {
    setError(null);
    let target;
    try {
      // The click on Export is the user gesture the save or folder picker needs, so ask first.
      target = await chooseExportTarget(name, settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!target) return;
    const controller = new AbortController();
    abort.current = controller;
    setProgress({ stage: 'render', fraction: 0 });
    try {
      const res = await runExport(services, settings, target, { signal: controller.signal, onProgress: setProgress });
      services.session
        .getState()
        .toast(
          res.names.length > 1
            ? `Exported ${res.names.length} stems (${formatTime(res.seconds)}) to “${target.name}”`
            : `Exported “${target.name}” (${formatTime(res.seconds)})`,
        );
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
  const codec = CODECS.find((c) => c.value === settings.codec) ?? CODECS[0]!;
  const rates = settings.codec === 'mp3' ? RATES.filter((r) => MP3_SAMPLE_RATES.includes(r)) : RATES;
  const rate = effectiveRate(settings);
  const stage =
    progress?.stage === 'encode'
      ? progress.label === 'Zip'
        ? 'Packing the .zip'
        : 'Encoding'
      : progress?.label
        ? `Rendering ${progress.label}`
        : 'Rendering';
  return (
    <div className={dialog.backdrop}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`${dialog.dialog} ${styles.export} ${tab === 'video' ? styles.exportVideo : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-export-title"
      >
        <h2 id="ag-export-title" className={dialog.title}>
          {tab === 'video' ? 'Export as video' : 'Export audio'}
        </h2>
        <div className={`${styles.segmented} ${styles.tabs}`} role="radiogroup" aria-label="What to export">
          {(['audio', 'video'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={tab === t}
              disabled={busy || videoBusy}
              className={`${styles.segment} ${tab === t ? styles.segmentOn : ''}`}
              onClick={() => exportStore.setState({ tab: t })}
              data-hint={
                t === 'audio'
                  ? 'Export sound as a WAV, FLAC or MP3 file, or as stems'
                  : 'Export a music video: the song with moving pictures, as a shareable MP4 or WebM file'
              }
            >
              {t === 'audio' ? 'Audio' : 'Video'}
            </button>
          ))}
        </div>
        <fieldset className={styles.group} disabled={busy || videoBusy}>
          <legend>Range</legend>
          {ranges.map((r) => {
            const info = describe(rangeOf(r.value));
            return (
              <label
                key={r.value}
                className={`${styles.option} ${info ? '' : styles.optionOff}`}
                data-hint={info ? `${r.hint} (${info})` : `${r.hint}: not available`}
              >
                <input
                  type="radio"
                  name="range"
                  checked={choice === r.value}
                  disabled={!info}
                  onChange={() => setChoice(r.value)}
                />
                <span>{r.label}</span>
                <span className={styles.meta}>{info ?? 'not available'}</span>
              </label>
            );
          })}
        </fieldset>

        {tab === 'video' ? (
          <VideoPanel range={range} onBusy={setVideoBusy} abortRef={abort} onClose={close} />
        ) : (
          <>
            <fieldset className={styles.group} disabled={busy}>
              <legend>What to export</legend>
              <label className={styles.option} data-hint="Everything you hear, mixed into one file">
                <input
                  type="radio"
                  name="what"
                  checked={!settings.stems}
                  onChange={() => set({ exportStems: false })}
                />
                <span>The mix (one file)</span>
              </label>
              <label
                className={`${styles.option} ${stems.length ? '' : styles.optionOff}`}
                data-hint="One file per mixer track that plays something, all the same length, so they line up in another app"
              >
                <input
                  type="radio"
                  name="what"
                  checked={settings.stems}
                  disabled={stems.length === 0}
                  onChange={() => set({ exportStems: true })}
                />
                <span>Stems: one file per mixer track</span>
                <span className={styles.meta}>
                  {stems.length ? `${stems.length} track${stems.length === 1 ? '' : 's'}` : 'nothing plays'}
                </span>
              </label>
              {settings.stems && (
                <div className={styles.sub}>
                  <p className={styles.note}>{stems.map((s) => s.name).join(' · ')}</p>
                  <label
                    className={styles.option}
                    data-hint="On: each stem goes through the master's effects and volume, like the mix. Off: raw stems that add up exactly to the master's input"
                  >
                    <input
                      type="checkbox"
                      checked={settings.masterChain}
                      onChange={(e) => set({ exportMasterChain: e.target.checked })}
                    />
                    <span>Through the master track (its effects and volume)</span>
                  </label>
                  <p className={styles.note}>
                    {settings.masterChain
                      ? 'Each stem sounds like it does in the mix. With master effects such as a compressor, stems played together can differ slightly from the mix.'
                      : 'Raw stems: they add up exactly to the mix before the master. Best when you mix or master in another app (use 32-bit float WAV if they are loud).'}
                  </p>
                  <div className={styles.row} data-hint="Where the stem files go">
                    <label className={styles.option}>
                      <input
                        type="radio"
                        name="to"
                        checked={settings.stemsTo === 'folder'}
                        onChange={() => set({ exportStemsTo: 'folder' })}
                      />
                      <span>Into a folder</span>
                    </label>
                    <label className={styles.option}>
                      <input
                        type="radio"
                        name="to"
                        checked={settings.stemsTo === 'zip'}
                        onChange={() => set({ exportStemsTo: 'zip' })}
                      />
                      <span>As one .zip file</span>
                    </label>
                  </div>
                </div>
              )}
            </fieldset>

            <fieldset className={styles.group} disabled={busy}>
              <legend>File format</legend>
              <div className={styles.segmented} role="radiogroup" aria-label="File format">
                {CODECS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={settings.codec === c.value}
                    className={`${styles.segment} ${settings.codec === c.value ? styles.segmentOn : ''}`}
                    onClick={() => set({ exportCodec: c.value })}
                    data-hint={`${c.label}: ${c.note}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <p className={styles.note}>{codec.note}</p>
              <div className={styles.row}>
                {settings.codec === 'wav' && (
                  <label
                    className={styles.field}
                    data-hint="Bits per sample: more bits keep more detail in quiet passages"
                  >
                    Bit depth
                    <select
                      value={prefs.exportFormat}
                      onChange={(e) => set({ exportFormat: e.target.value as PrefsState['exportFormat'] })}
                    >
                      {WAV_DEPTHS.map((d) => (
                        <option key={d.value} value={d.value} title={d.hint}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {settings.codec === 'flac' && (
                  <label
                    className={styles.field}
                    data-hint="Bits per sample: 16-bit is CD quality (dithered), 24-bit keeps more detail"
                  >
                    Bit depth
                    <select value={settings.flacBits} onChange={(e) => set({ exportFlacBits: Number(e.target.value) })}>
                      <option value={16}>16-bit</option>
                      <option value={24}>24-bit</option>
                    </select>
                  </label>
                )}
                {settings.codec === 'mp3' && (
                  <label
                    className={styles.field}
                    data-hint="Bit rate in kbps (kilobits per second): higher sounds better and makes bigger files"
                  >
                    Quality
                    <select value={settings.mp3Kbps} onChange={(e) => set({ exportMp3Kbps: Number(e.target.value) })}>
                      {MP3_BITRATES.map((k) => (
                        <option key={k} value={k}>
                          {k} kbps{k === 320 ? ' (best)' : k === 128 ? ' (smallest)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label
                  className={styles.field}
                  data-hint="Samples per second in kHz: 44.1 for music sites and CDs, 48 for video"
                >
                  Sample rate
                  <select value={rate} onChange={(e) => set({ exportSampleRate: Number(e.target.value) })}>
                    {rates.map((r) => (
                      <option key={r} value={r}>
                        {r / 1000} kHz
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label
                className={styles.option}
                data-hint="Turns the whole export up (or down) so its loudest moment peaks at −0.3 dBFS, just under the maximum"
              >
                <input
                  type="checkbox"
                  checked={settings.normalize}
                  onChange={(e) => set({ exportNormalize: e.target.checked })}
                />
                <span>Normalize: make the loudest moment peak at −0.3 dB</span>
              </label>
              {settings.normalize && settings.stems && (
                <p className={styles.note}>
                  Stems are raised together, by the same amount, so they still add up to the mix.
                </p>
              )}
            </fieldset>
            <p className={dialog.detail}>
              Renders with the same engine as playback, including release and effect tails; the silence after the last
              tail is trimmed. For MIDI, use File › Export song as MIDI.
            </p>
            {busy && (
              <div className={styles.progress} role="progressbar" aria-valuenow={Math.round(progress.fraction * 100)}>
                <div className={styles.bar} style={{ width: `${progress.fraction * 100}%` }} />
                <span>
                  {stage}… {Math.round(progress.fraction * 100)}%
                </span>
              </div>
            )}
            {error && <p className={styles.error}>{error}</p>}
            <div className={dialog.buttons}>
              <button
                className={dialog.button}
                onClick={close}
                data-hint="Close without exporting (Esc); stops an export that is running"
              >
                Cancel
              </button>
              {!busy && (
                <button
                  className={`${dialog.button} ${dialog.primary}`}
                  disabled={'error' in plan || (settings.stems && stems.length === 0)}
                  onClick={() => void start()}
                  data-hint={
                    settings.stems
                      ? settings.stemsTo === 'folder'
                        ? 'Choose a folder, then the stems are rendered into it'
                        : 'Choose where to save the .zip, then the stems are rendered'
                      : `Choose where to save the ${codec.label} file, then it is rendered`
                  }
                >
                  Export…
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
