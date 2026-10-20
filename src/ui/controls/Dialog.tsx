import { useEffect, useRef } from 'react';
import { createStore, useStore } from 'zustand';
import { useDialogFocus } from './dialog-focus';
import styles from './Dialog.module.css';

/**
 * Modal dialogs (unsaved changes, crash recovery, export). A click on a dialog button counts as a
 * fresh user gesture, so the action behind it can still open a file picker.
 */
export interface DialogButton<T extends string> {
  id: T;
  label: string;
  /** Default button: Enter chooses it. */
  primary?: boolean;
  danger?: boolean;
}

export interface DialogOptions<T extends string> {
  title: string;
  message: string;
  /** Smaller text under the message. */
  detail?: string;
  buttons: DialogButton<T>[];
  /** Chosen by Escape. */
  cancelId: T;
}

interface Open {
  /** Tells one queued question from the next, so each opens fresh. */
  id: number;
  options: DialogOptions<string>;
  resolve(id: string): void;
}

let nextDialogId = 0;

const dialogStore = createStore<{ queue: Open[] }>(() => ({ queue: [] }));

export function showDialog<T extends string>(options: DialogOptions<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    const entry: Open = { id: nextDialogId++, options, resolve: resolve as (id: string) => void };
    dialogStore.setState({ queue: [...dialogStore.getState().queue, entry] });
  });
}

let heldModals = 0;

/** For feature modals (e.g. export): global shortcuts stand down until the returned function runs. */
export function holdModal(): () => void {
  heldModals++;
  let held = true;
  return () => {
    if (held) heldModals--;
    held = false;
  };
}

/** True while a dialog is up: global shortcuts and the typing keyboard stand down. */
export function isModalOpen(): boolean {
  return dialogStore.getState().queue.length > 0 || heldModals > 0;
}

function close(entry: Open, id: string): void {
  dialogStore.setState({ queue: dialogStore.getState().queue.filter((e) => e !== entry) });
  entry.resolve(id);
}

/** Rendered once by the app shell. */
export function DialogHost() {
  const entry = useStore(dialogStore, (s) => s.queue[0]);
  // Keyed by the entry: a second dialog queued behind the first opens fresh (focus, keys) once the first is answered.
  return entry ? <AlertDialog key={entry.id} entry={entry} /> : null;
}

/** One question: Enter picks the default button and Esc the cancel button; Tab stays inside (see `useDialogFocus`). */
function AlertDialog({ entry }: { entry: Open }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // The dialog itself takes focus, not a button: Space is play/stop muscle memory in a DAW and must
  // not "click" Save. Enter picks the default button; Tab reaches the buttons.
  useDialogFocus(dialogRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(entry, entry.options.cancelId);
      } else if (e.key === 'Enter') {
        // A button the user tabbed to handles Enter itself.
        if (document.activeElement instanceof HTMLButtonElement && dialogRef.current?.contains(document.activeElement))
          return;
        const primary = entry.options.buttons.find((b) => b.primary);
        if (!primary) return;
        e.preventDefault();
        e.stopPropagation();
        close(entry, primary.id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [entry]);

  const { title, message, detail, buttons } = entry.options;
  return (
    <div className={styles.backdrop}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ag-dialog-title"
        aria-describedby="ag-dialog-message"
      >
        <h2 id="ag-dialog-title" className={styles.title}>
          {title}
        </h2>
        <p id="ag-dialog-message" className={styles.message}>
          {message}
        </p>
        {detail && <p className={styles.detail}>{detail}</p>}
        <div className={styles.buttons}>
          {buttons.map((b) => (
            <button
              key={b.id}
              className={`${styles.button} ${b.primary ? styles.primary : ''} ${b.danger ? styles.danger : ''}`}
              onClick={() => close(entry, b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
