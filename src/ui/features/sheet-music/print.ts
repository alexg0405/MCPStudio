/**
 * Print and "save as PDF": the browser's own print dialog, with a copy of the score laid out for paper. The app's windows are
 * hidden by the print stylesheet (`sheet-music.css`) and only the copy shows, black on white whatever the theme, each system
 * kept whole at the bottom of a page.
 */
import type { ActionResult } from '@app/notation/actions';
import { sheetState } from '@app/notation/sheet';
import type { Services } from '@app/services';
import { renderSheet } from '@core/notation/render';
import './sheet-music.css';

/** Layout width (px) of a printed page: the width of A4 and Letter inside 15 mm margins at 96 pixels per inch. */
const PAGE_LAYOUT_WIDTH = 680;
const PRINT_ROOT_ID = 'ag-print-root';

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Builds the printable copy of the sheet; null when there is nothing to print. */
export function buildPrintPage(s: Services): HTMLElement | null {
  const state = sheetState(s);
  if (!state) return null;
  const project = s.doc.getState().project;
  const rendered = renderSheet(state.score, { width: PAGE_LAYOUT_WIDTH, zoom: 1 });
  const pattern = project.patterns[state.patternId];
  const title = [project.meta.title, pattern?.name].filter(Boolean).join(' - ');
  const timeSig = state.score.timeSig;
  const details = [`${state.part.label}`, `${timeSig.num}/${timeSig.den}`, state.score.keySignature.name, `tempo ${Math.round(state.score.bpm)} bpm`];
  const root = document.createElement('div');
  root.id = PRINT_ROOT_ID;
  root.innerHTML = `<h1>${escapeHtml(title || 'Sheet music')}</h1><p>${escapeHtml(details.join(' · '))}</p>${rendered.systems.join('')}`;
  return root;
}

/** Opens the print dialog with the sheet; the choice "Save as PDF" is in the dialog. */
export function printSheet(s: Services): ActionResult {
  const page = buildPrintPage(s);
  if (!page) return { ok: false, message: 'There is no sheet music to print: open a pattern that has notes.' };
  document.getElementById(PRINT_ROOT_ID)?.remove();
  document.body.append(page);
  const root = document.documentElement;
  root.classList.add('ag-printing');
  const cleanUp = () => {
    root.classList.remove('ag-printing');
    page.remove();
    window.removeEventListener('afterprint', cleanUp);
  };
  window.addEventListener('afterprint', cleanUp);
  // Chrome waits inside print() for the dialog and then fires afterprint; if a browser never does, the copy goes after a minute.
  setTimeout(cleanUp, 60_000);
  window.print();
  return { ok: true, message: 'Opened the print dialog: choose "Save as PDF" as the destination to make a PDF.' };
}
