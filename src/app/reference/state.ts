import { createStore } from 'zustand/vanilla';
import type { ToneComparison } from '@core/reference/bands';
import type { SongTone } from './song-tone';

/** What the last "Show the tonal difference" found: the song's balance next to the reference's. */
export interface ToneReport {
  projectId: string;
  /** The reference it was compared with. */
  referenceHash: string;
  song: SongTone;
  comparison: ToneComparison;
  /** The findings in plain words. */
  lines: string[];
}

export interface ReferenceUiState {
  /** Something is being analyzed or measured: what, and how far (0–1). */
  working: { label: string; fraction: number } | null;
  /** The last tonal comparison (it ages: the song may change after it). */
  tone: ToneReport | null;
}

/** View state of the Reference panel and the Studio's last measurements (not part of the document). */
export const referenceState = createStore<ReferenceUiState>(() => ({ working: null, tone: null }));
