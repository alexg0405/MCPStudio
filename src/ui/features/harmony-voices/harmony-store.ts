import { createStore } from 'zustand';
import type { ClipId } from '@core/model/types';

/**
 * Whether the "Make harmonies" dialog is open, and for which lead clip. View state: not in the document. The seed is chosen when it
 * opens, so the preview and the harmonies made from it are the same takes.
 */
export const harmonyStore = createStore<{ open: { clipId: ClipId; seed: number } | null }>(() => ({ open: null }));

/** Opens the dialog for a lead clip. */
export const openHarmonyDialog = (clipId: ClipId): void =>
  harmonyStore.setState({ open: { clipId, seed: (Math.random() * 0x100000000) >>> 0 } });

/** Closes the dialog. */
export const closeHarmonyDialog = (): void => harmonyStore.setState({ open: null });
