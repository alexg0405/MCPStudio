import { useEffect, type RefObject } from 'react';

/** Controls Tab can land on inside a dialog. */
const TABBABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** The dialog's visible controls in Tab order (the dialog's own `tabindex="-1"` is not one). */
function tabbableIn(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  );
}

/**
 * What every modal dialog does for the keyboard, in one place: on opening the dialog itself takes the focus (not a button,
 * so Space does not press one by accident), Tab and Shift+Tab stay inside it, and when it closes the focus goes back to
 * the control that opened it. The dialog element needs `tabIndex={-1}`, `role="dialog"` (or `alertdialog`), `aria-modal`
 * and a name (`aria-labelledby` its title).
 */
export function useDialogFocus(dialogRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.contains(document.activeElement)) dialog.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
      const items = tabbableIn(dialog);
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && dialog.contains(active) && active !== dialog;
      const here = inside ? items.indexOf(active) : -1;
      // On a control the browser moves between by itself (a radio that is not a tab stop): its Tab is fine.
      if (inside && here === -1) return;
      const atEdge = !inside || (e.shiftKey ? here === 0 : here === items.length - 1);
      if (!atEdge) return;
      e.preventDefault();
      const target = (e.shiftKey ? items[items.length - 1] : items[0]) ?? dialog;
      target.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected && opener !== document.body) opener.focus();
    };
  }, [dialogRef]);
}
