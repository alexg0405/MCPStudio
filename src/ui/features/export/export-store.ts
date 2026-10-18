import { createStore } from 'zustand';
import type { Tick } from '@core/model/types';

/** A span of the song the dialog was opened for (a section, the loop, a clip's bars). */
export interface ExportSpan {
  from: Tick;
  to: Tick;
  /** How the dialog names it: “Verse”, the loop, bars 5–8. */
  label: string;
}

export interface ExportDialogState {
  open: boolean;
  /** Which half is showing: the audio export or the video export. */
  tab: 'audio' | 'video';
  /** Set when the dialog was opened from a part of the song: a fourth choice in its Range. */
  span: ExportSpan | null;
}

/**
 * Whether the export dialog is open (File > Export audio / Export as video / Export stems). Kept out of the
 * component file so editing the dialog hot-updates instead of reloading the page.
 */
export const exportStore = createStore<ExportDialogState>(() => ({ open: false, tab: 'audio', span: null }));

/** Opens the dialog on the audio or video tab, for the whole song or for a part of it. */
export function openExport(tab: 'audio' | 'video', span: ExportSpan | null = null): void {
  exportStore.setState({ open: true, tab, span });
}
