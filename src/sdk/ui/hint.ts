/**
 * Controls report live values ("Cutoff 1.20 kHz") while dragging through a bubbling DOM event,
 * so they work inside plugin UIs without knowing about the host. The host shows it in its hint bar.
 */
export const HINT_EVENT = 'ag-hint';

/** Reports a live value ("Cutoff 1.20 kHz") from a control; the host shows it in its hint bar. */
export function emitHint(from: Element, text: string): void {
  from.dispatchEvent(new CustomEvent(HINT_EVENT, { bubbles: true, detail: text }));
}
