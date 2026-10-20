import { createStore } from 'zustand/vanilla';
import type { ClipId } from '@core/model/types';

/** View state of the Clean up vocal window (not part of the document, not in History). */
export interface CleanupWindowState {
  /** The clip the window shows. */
  clipId: ClipId | null;
  /** A render is running for this clip, and how far it is (0–1). */
  rendering: { clipId: ClipId; fraction: number } | null;
  /** Why a clip's last render could not do everything asked (for example no quiet stretch to learn the noise from), by clip. */
  problems: Readonly<Record<string, string>>;
  /** How many mouth clicks the last render repaired, by clip. */
  clicks: Readonly<Record<string, number>>;
  /** True while the "what was removed" sound plays. */
  hearingRemoved: boolean;
}

/** The window's state. */
export const cleanupState = createStore<CleanupWindowState>(() => ({
  clipId: null,
  rendering: null,
  problems: {},
  clicks: {},
  hearingRemoved: false,
}));
