import { useEffect, useRef, type RefObject } from 'react';
import { useStore } from 'zustand';
import type { Services } from '@app/services';
import { holdModal } from '../../controls/Dialog';
import { useDialogFocus } from '../../controls/dialog-focus';
import { useDoc, useServices } from '../../services-context';
import dialog from '../../controls/Dialog.module.css';
import { InputDeviceSection, LatencySection, MonitoringSection, PunchSection, RecordWhatSection } from './AudioInputSections';
import { audioInputDialog, calibrationStore } from './audio-input-store';
import styles from './Recording.module.css';

/** Overlay host: renders the dialog while the audio input command has it open. */
export function AudioInputOverlay() {
  const open = useStore(audioInputDialog, (s) => s.open);
  return open ? <AudioInputDialog /> : null;
}

/** Stops a running calibration, forgets its result and closes the dialog. */
function closeDialog(): void {
  calibrationStore.getState().abort?.abort();
  calibrationStore.setState({ c: { state: 'idle' }, abort: null });
  audioInputDialog.setState({ open: false });
}

/**
 * While the dialog is open the app behind it is locked, the dialog takes the keyboard and Esc closes it. Opening the
 * dialog also opens the input, which shows the meter (and asks for permission the first time: the menu click is the gesture).
 */
function useModalAndInput(dialogRef: RefObject<HTMLDivElement | null>, services: Services): void {
  useDialogFocus(dialogRef);
  useEffect(() => {
    const release = holdModal();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeDialog();
    };
    window.addEventListener('keydown', onKey, true);
    void services.audioInput.open().then(() => services.audioInput.refreshDevices());
    return () => {
      release();
      window.removeEventListener('keydown', onKey, true);
    };
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** The Audio input dialog: what record mode records from, what it keeps, monitoring, punch and takes, and latency. */
function AudioInputDialog() {
  const services = useServices();
  const prefs = useStore(services.prefs);
  const input = useStore(services.audioInput.store);
  const mixer = useDoc((p) => p.mixer);
  const calibration = useStore(calibrationStore, (st) => st.c);
  const dialogRef = useRef<HTMLDivElement>(null);
  const set = services.prefs.getState().set;
  useModalAndInput(dialogRef, services);

  return (
    <div className={dialog.backdrop}>
      <div ref={dialogRef} tabIndex={-1} className={`${dialog.dialog} ${styles.dialog}`} role="dialog" aria-modal="true" aria-labelledby="ag-input-title">
        <h2 id="ag-input-title" className={dialog.title}>
          Audio input
        </h2>
        <p className={styles.note}>
          What record mode (R) records from: a microphone or an audio interface. Recordings land on the playlist where you played them.
        </p>
        <InputDeviceSection services={services} prefs={prefs} input={input} set={set} />
        <RecordWhatSection prefs={prefs} set={set} />
        <MonitoringSection prefs={prefs} mixer={mixer} set={set} />
        <PunchSection prefs={prefs} set={set} />
        <LatencySection
          services={services}
          prefs={prefs}
          calibration={calibration}
          onForgetCalibration={() => calibrationStore.setState({ c: { state: 'idle' } })}
          set={set}
        />
        <div className={dialog.buttons}>
          <button className={`${dialog.button} ${dialog.primary}`} onClick={closeDialog}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
