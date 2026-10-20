/**
 * Vocal alignment of audio clips as user actions (the Align window, the clip menus, the AI and MCP share these): settings
 * that are one undo step each, and the renderer that keeps the aligned audio up to date (`align-render.ts`, re-exported
 * here).
 *
 * An alignment is a record on the clip (`AudioClip.align`); the render follows by itself after the edit and is written
 * into the same undo step. The recording stays as it was, and the Pitch editor works on the aligned sound (align first,
 * then tune: see `core/audio/playback.ts` `clipSampleId`).
 */
import {
  DEFAULT_GRID_STEP_TICKS,
  DEFAULT_GRID_STRENGTH,
  DEFAULT_PITCH_ALIGN,
  DEFAULT_TIGHTNESS,
} from '@core/audio/align/edit';
import { alignProblem, guideProblem } from '@core/audio/align/plan';
import type { AlignEdit, AudioClip, ClipId, Project } from '@core/model/types';
import { setAlign } from '@core/ops/align';
import type { Services } from '../services';
import { audioClipOf } from './pitch-clip';

export { ALIGN_RENDER_DELAY_MS, renderAlignmentNow, startAlignRenderer } from './align-render';

/** What an alignment request says. */
export interface AlignRequest {
  /** The clips to align. */
  clips: readonly ClipId[];
  /** Guide mode: the clip to follow. */
  guide: ClipId;
  /** 0–100 (default 70). */
  tightness?: number;
  /** 0–100 % (default 0). */
  pitch?: number;
}

/** What a grid request says. */
export interface GridRequest {
  clips: readonly ClipId[];
  /** 0–100 % (default 80). */
  strength?: number;
  /** Ticks between grid lines (default 240, a 1/16 step). */
  stepTicks?: number;
}

/** What was done: the clips that were set, and why the others were not. */
export interface AlignResult {
  aligned: ClipId[];
  skipped: { clip: ClipId; reason: string }[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The audio clips among `ids`, in the order given (others are ignored). */
export function audioClipsAmong(p: Project, ids: readonly ClipId[]): AudioClip[] {
  return ids.map((id) => audioClipOf(p, id)?.clip).filter((c): c is AudioClip => !!c);
}

/** The selected audio clips (what the menus and commands act on when no clip is named). */
export function selectedAudioClips(s: Services): AudioClip[] {
  return audioClipsAmong(s.doc.getState().project, s.editor.getState().clipSelection);
}

/** The edit that aligns a clip to a guide, with the settings clamped. */
export function guideEdit(req: Pick<AlignRequest, 'guide' | 'tightness' | 'pitch'>): AlignEdit {
  const edit: AlignEdit = { mode: 'guide', guide: req.guide, tightness: clamp(req.tightness ?? DEFAULT_TIGHTNESS, 0, 100) };
  const pitch = clamp(req.pitch ?? DEFAULT_PITCH_ALIGN, 0, 100);
  if (pitch > 0) edit.pitch = pitch;
  return edit;
}

/** The edit that tightens a clip to the grid, with the settings clamped. */
export function gridEdit(req: Omit<GridRequest, 'clips'>): AlignEdit {
  return {
    mode: 'grid',
    tightness: DEFAULT_TIGHTNESS,
    strength: clamp(req.strength ?? DEFAULT_GRID_STRENGTH, 0, 100),
    stepTicks: Math.max(1, Math.round(req.stepTicks ?? DEFAULT_GRID_STEP_TICKS)),
  };
}

/** Sets the edit on every clip that can take it (one undo step); the others come back with the reason. */
function applyEdit(s: Services, ids: readonly ClipId[], make: (id: ClipId) => AlignEdit, check: (p: Project, id: ClipId) => string | null, label: string): AlignResult {
  const project = s.doc.getState().project;
  const result: AlignResult = { aligned: [], skipped: [] };
  for (const id of ids) {
    const problem = check(project, id);
    if (problem) result.skipped.push({ clip: id, reason: problem });
    else result.aligned.push(id);
  }
  if (result.aligned.length === 0) return result;
  s.history.transact(
    result.aligned.length > 1 ? `${label} (${result.aligned.length} clips)` : label,
    (d) => {
      for (const id of result.aligned) setAlign(d, id, make(id));
    },
  );
  return result;
}

/** Aligns the clips to the guide: one undo step; the aligned audio is made in the background. */
export function alignClips(s: Services, req: AlignRequest): AlignResult {
  const edit = guideEdit(req);
  const check = (p: Project, id: ClipId) => alignProblem(p, id) ?? guideProblem(p, id, req.guide);
  return applyEdit(s, req.clips, () => edit, check, 'Align to guide');
}

/** Tightens the clips' syllable onsets to the grid: one undo step; the audio is made in the background. */
export function tightenClips(s: Services, req: GridRequest): AlignResult {
  const edit = gridEdit(req);
  return applyEdit(s, req.clips, () => edit, (p, id) => alignProblem(p, id), 'Tighten timing to the grid');
}

/** Removes the alignment of the clips (they play their own audio again): one undo step. Returns how many were aligned. */
export function removeAlignment(s: Services, ids: readonly ClipId[]): number {
  const aligned = audioClipsAmong(s.doc.getState().project, ids).filter((c) => c.align);
  if (aligned.length === 0) return 0;
  s.history.transact(aligned.length > 1 ? `Remove alignment (${aligned.length} clips)` : 'Remove alignment', (d) => {
    for (const c of aligned) setAlign(d, c.id, null);
  });
  return aligned.length;
}

/**
 * A/B: hear a clip as recorded (`original` true), without its alignment and pitch correction, or the aligned sound
 * again (false); without `original` it switches. Session state only: nothing in the document changes. Returns true when
 * the original is heard now.
 */
export function hearUnaligned(s: Services, clipId: ClipId, original?: boolean): boolean {
  const editor = s.editor.getState();
  const next = original ?? !editor.alignOriginal.includes(clipId);
  editor.setAlignOriginal(clipId, next);
  return next;
}

/** True when a clip's alignment settings differ from what its render was made for (it is being made, or failed). */
export function alignmentIsStale(p: Project, id: ClipId, signature: string | null): boolean {
  const align = audioClipOf(p, id)?.clip.align;
  return !!align && (!align.renderedSampleId || align.renderedFor !== signature);
}
