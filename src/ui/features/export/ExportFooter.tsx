import dialog from '../../controls/Dialog.module.css';
import styles from './ExportDialog.module.css';

interface ExportFooterProps {
  /** How far the running export is (0 to 1), or null when none is running. */
  fraction: number | null;
  /** What it is doing now ("Rendering the audio"); shown with the percent. */
  stageText: string;
  /** What went wrong last time, if anything. */
  errorText: string | null;
  /** The label and hint of the main button, and whether it can be pressed. */
  startLabel: string;
  startHint: string;
  canStart: boolean;
  /** The hint of the Cancel button. */
  cancelHint: string;
  onStart(): void;
  onCancel(): void;
}

/** The bottom of an export tab: the progress bar while it runs, the last error, and the Cancel and Export buttons. */
export function ExportFooter({ fraction, stageText, errorText, startLabel, startHint, canStart, cancelHint, onStart, onCancel }: ExportFooterProps) {
  const percent = fraction === null ? 0 : Math.round(fraction * 100);
  return (
    <>
      {fraction !== null && (
        <div className={styles.progress} role="progressbar" aria-valuenow={percent}>
          <div className={styles.bar} style={{ width: `${fraction * 100}%` }} />
          <span>
            {stageText}… {percent}%
          </span>
        </div>
      )}
      {errorText && <p className={styles.error}>{errorText}</p>}
      <div className={dialog.buttons}>
        <button className={dialog.button} onClick={onCancel} data-hint={cancelHint}>
          Cancel
        </button>
        {fraction === null && (
          <button className={`${dialog.button} ${dialog.primary}`} disabled={!canStart} onClick={onStart} data-hint={startHint}>
            {startLabel}
          </button>
        )}
      </div>
    </>
  );
}
