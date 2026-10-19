import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { useStore } from 'zustand';
import { effectiveRate, exportSettingsFrom } from '@app/export/audio-export';
import { planExport } from '@app/export/plan';
import type { PrefsState } from '@app/stores/prefs';
import { planStems, withoutMasterChain } from '@core/query/stems';
import { ticksPerBar } from '@core/time/ppq';
import { holdModal } from '../../controls/Dialog';
import { useDoc, useServices, useView } from '../../services-context';
import dialog from '../../controls/Dialog.module.css';
import { FormatSection, RangeSection, StemsSection } from './AudioExportSections';
import { audioStageText, audioStartHint, codecInfo, initialRangeChoice, rangeOfChoice, rangeOptions, sampleRatesFor, type RangeChoice } from './audio-options';
import { ExportFooter } from './ExportFooter';
import { exportStore } from './export-store';
import { useAudioExport } from './use-audio-export';
import { VideoPanel } from './VideoPanel';
import styles from './ExportDialog.module.css';

/** Overlay host: renders the dialog while the export command has it open. */
export function ExportOverlay() {
  const open = useStore(exportStore, (s) => s.open);
  return open ? <ExportDialog /> : null;
}

/**
 * While the dialog is open the app behind it is locked, the dialog takes the keyboard, and Esc stops a running
 * export (or closes the dialog when none is running).
 */
function useModalKeyboard(dialogRef: RefObject<HTMLDivElement | null>, abortRef: MutableRefObject<AbortController | null>) {
  useEffect(() => {
    const release = holdModal();
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (abortRef.current) abortRef.current.abort();
      else exportStore.setState({ open: false });
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      release();
      window.removeEventListener('keydown', onKey, true);
    };
  }, [dialogRef, abortRef]);
}

/** The Export dialog: a tab for audio (WAV, FLAC, MP3, stems) and one for video, over a shared Range section. */
function ExportDialog() {
  const services = useServices();
  const project = useDoc((p) => p);
  const view = useView((v) => v);
  const prefs = useStore(services.prefs);
  const set = (patch: Partial<PrefsState>) => services.prefs.getState().set(patch);
  const tab = useStore(exportStore, (e) => e.tab);
  const span = useStore(exportStore, (e) => e.span);

  /** What the Range section shows as chosen: a named range, or the span the dialog was opened for. */
  const [rangeChoice, setRangeChoice] = useState<RangeChoice>(() => initialRangeChoice(project, view, span));
  const range = rangeOfChoice(rangeChoice, span);
  const [isVideoBusy, setIsVideoBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const settings = exportSettingsFrom(prefs, range);
  const audioExport = useAudioExport(settings, abortRef);
  const isAudioBusy = audioExport.progress !== null;

  const close = () => {
    abortRef.current?.abort();
    exportStore.setState({ open: false });
  };
  useModalKeyboard(dialogRef, abortRef);

  const plan = planExport(project, view, range);
  const stems = useMemo(() => {
    if ('error' in plan) return [];
    const base = prefs.exportMasterChain ? project : withoutMasterChain(project);
    const toTick = plan.fromTick + plan.bars * ticksPerBar(project.transport.timeSig);
    return planStems(base, { mode: plan.mode, patternId: plan.patternId, fromTick: plan.fromTick, toTick });
    // `plan` is derived from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, view, range, prefs.exportMasterChain]);

  const codec = codecInfo(settings.codec);
  const canStart = !('error' in plan) && !(settings.stems && stems.length === 0);
  return (
    <div className={dialog.backdrop}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`${dialog.dialog} ${styles.export} ${tab === 'video' ? styles.exportVideo : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-export-title"
      >
        <h2 id="ag-export-title" className={dialog.title}>
          {tab === 'video' ? 'Export as video' : 'Export audio'}
        </h2>
        <TabSwitch tab={tab} isLocked={isAudioBusy || isVideoBusy} />
        <RangeSection options={rangeOptions(project, view, span)} choice={rangeChoice} onChoose={setRangeChoice} isLocked={isAudioBusy || isVideoBusy} />

        {tab === 'video' ? (
          <VideoPanel range={range} onBusy={setIsVideoBusy} abortRef={abortRef} onClose={close} />
        ) : (
          <>
            <StemsSection settings={settings} stems={stems} set={set} isLocked={isAudioBusy} />
            <FormatSection
              settings={settings}
              wavDepth={prefs.exportFormat}
              sampleRates={sampleRatesFor(settings.codec)}
              sampleRate={effectiveRate(settings)}
              set={set}
              isLocked={isAudioBusy}
            />
            <p className={dialog.detail}>
              Renders with the same engine as playback, including release and effect tails; the silence after the last tail is trimmed. For MIDI, use File › Export song
              as MIDI.
            </p>
            <ExportFooter
              fraction={audioExport.progress?.fraction ?? null}
              stageText={audioExport.progress ? audioStageText(audioExport.progress) : ''}
              errorText={audioExport.error}
              startLabel="Export…"
              startHint={audioStartHint(settings, codec.label)}
              canStart={canStart}
              cancelHint="Close without exporting (Esc); stops an export that is running"
              onStart={() => void audioExport.start()}
              onCancel={close}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** The Audio and Video buttons at the top of the dialog. */
function TabSwitch({ tab, isLocked }: { tab: 'audio' | 'video'; isLocked: boolean }) {
  return (
    <div className={`${styles.segmented} ${styles.tabs}`} role="radiogroup" aria-label="What to export">
      {(['audio', 'video'] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={tab === t}
          disabled={isLocked}
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
  );
}
