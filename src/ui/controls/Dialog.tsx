import { useEffect, useRef } from 'react';
import { createStore, useStore } from 'zustand';
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
  options: DialogOptions<string>;
  resolve(id: string): void;
}

const dialogStore = createStore<{ queue: Open[] }>(() => ({ queue: [] }));

export function showDialog<T extends string>(options: DialogOptions<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    const entry: Open = { options, resolve: resolve as (id: string) => void };
    dialogStore.setState({ queue: [...dialogStore.getState().queue, entry] });
  });
}

/** True while a dialog is up: global shortcuts and the typing keyboard stand down. */
export function isModalOpen(): boolean {
  return dialogStore.getState().queue.length > 0;
}

function close(entry: Open, id: string): void {
  dialogStore.setState({ queue: dialogStore.getState().queue.filter((e) => e !== entry) });
  entry.resolve(id);
}

/** Rendered once by the app shell. */
export function DialogHost() {
  const entry = useStore(dialogStore, (s) => s.queue[0]);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!entry) return;
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The dialog itself takes focus, not a button: Space is play/stop muscle memory in a DAW and must
    // not "click" Save. Enter picks the default button; Tab reaches the buttons.
    dialogRef.current?.focus();
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
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
    };
  }, [entry]);

  if (!entry) return null;
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
      >
        <h2 id="ag-dialog-title" className={styles.title}>
          {title}
        </h2>
        <p className={styles.message}>{message}</p>
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
