import { createStore } from 'zustand/vanilla';
import type { ClipId } from '@core/model/types';
import type { PitchAnalysis } from '@core/voice/pitch-notes';

/** A clip's analysed pitch: what the Pitch editor draws. */
export interface ClipPitch {
  clipId: ClipId;
  /** The stretch of the clip's sample that was analysed (seconds on the sample's own timeline). */
  range: { from: number; to: number };
  /** Length of the clip's sample, seconds. */
  duration: number;
  analysis: PitchAnalysis;
}

export interface PitchEditorState {
  /** The clip the Pitch editor shows. */
  clipId: ClipId | null;
  phase: 'none' | 'analyzing' | 'ready' | 'error';
  /** Why there is nothing to show (phase 'error'), in plain words. */
  message: string;
  clip: ClipPitch | null;
  /** A render of the corrected audio is running for this clip, and how far it is (0–1). */
  rendering: { clipId: ClipId; fraction: number } | null;
  /** Selected notes (indices into the clip's note list). */
  selected: number[];
  /** The key "Snap all to key" pulls to: root 0–11, scale id, and how far (0–1). */
  keyRoot: number;
  keyScale: string;
  strength: number;
  /** Follows the song's key until the musician picks one here. */
  keyFollowsSong: boolean;
}

/** View state of the Pitch editor window (not part of the document, not in History). */
export const pitchState = createStore<PitchEditorState>(() => ({
  clipId: null,
  phase: 'none',
  message: '',
  clip: null,
  rendering: null,
  selected: [],
  keyRoot: 0,
  keyScale: 'major',
  strength: 1,
  keyFollowsSong: true,
}));
