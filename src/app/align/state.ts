import { createStore } from 'zustand/vanilla';
import type { ClipId } from '@core/model/types';
import type { AlignStats } from '@core/audio/align';

/** View state of vocal alignment (not part of the document, not in History): what is being rendered, what went wrong. */
export interface AlignViewState {
  /** Renders in flight for these clips, and how far each is (0–1). */
  rendering: Readonly<Record<string, number>>;
  /** Why a clip's alignment could not be rendered, in plain words. */
  problems: Readonly<Record<string, string>>;
  /** What the last render of each clip measured (the dialog and the AI's read show it). */
  lastStats: Readonly<Record<string, AlignStats>>;
  /** The clip the Align window shows (null = the selected audio clip). */
  windowClip: ClipId | null;
}

export const alignState = createStore<AlignViewState>(() => ({ rendering: {}, problems: {}, lastStats: {}, windowClip: null }));

/** Without `fraction` the clip is no longer rendering. */
export function setAlignProgress(clip: ClipId, fraction: number | null): void {
  const next = { ...alignState.getState().rendering };
  if (fraction === null) delete next[clip];
  else next[clip] = fraction;
  alignState.setState({ rendering: next });
}

/** Without `text` the clip has no problem. */
export function setAlignProblem(clip: ClipId, text: string | null): void {
  const current = alignState.getState().problems;
  if ((current[clip] ?? null) === text) return;
  const next = { ...current };
  if (text === null) delete next[clip];
  else next[clip] = text;
  alignState.setState({ problems: next });
}

/** Remembers what a render measured. */
export function setAlignStats(clip: ClipId, stats: AlignStats): void {
  alignState.setState({ lastStats: { ...alignState.getState().lastStats, [clip]: stats } });
}
