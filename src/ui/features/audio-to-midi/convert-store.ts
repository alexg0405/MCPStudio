import { createStore } from 'zustand';
import type { ClipId } from '@core/model/types';

/** Whether the "Convert to MIDI" dialog is open, and for which audio clip. View state: not in the document. */
export const convertStore = createStore<{ open: { clipId: ClipId } | null }>(() => ({ open: null }));

/** Opens the dialog for an audio clip. */
export const openConvertDialog = (clipId: ClipId): void => convertStore.setState({ open: { clipId } });

/** Closes the dialog. */
export const closeConvertDialog = (): void => convertStore.setState({ open: null });
