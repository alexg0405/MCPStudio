/**
 * What an alignment is as data (`AudioClip.align`): the defaults, reading and validating one that came from a project
 * file or the AI, and the sound a clip's later steps (the Pitch editor) start from. Plain data, no DOM.
 */
import type { AlignEdit, AudioClip, AudioClipChannel, SampleId } from '../../model/types';
import { editSignature } from '../pitch-edit/edit';
import { clipSourceSampleId } from '../playback';
import { MAX_WARP_POINTS } from './warp-knots';

/** Tightness the dialog and the AI start from (0 = only big offsets, 100 = syllable by syllable). */
export const DEFAULT_TIGHTNESS = 70;
/** Pitch alignment the dialog starts from, %: off, because it changes the sound more than moving it in time does. */
export const DEFAULT_PITCH_ALIGN = 0;
/** Grid strength the dialog starts from, %: the onsets go most of the way (a trace of the human feel stays). */
export const DEFAULT_GRID_STRENGTH = 80;
/** Ticks between grid lines when the edit does not say: a 1/16 step. */
export const DEFAULT_GRID_STEP_TICKS = 240;
/** The grid steps the dialog offers: ticks and what they are called. */
export const GRID_STEPS: readonly { ticks: number; label: string }[] = [
  { ticks: 960, label: '1/4 (beat)' },
  { ticks: 480, label: '1/8' },
  { ticks: 240, label: '1/16' },
  { ticks: 120, label: '1/32' },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The pitch alignment of a guide-mode edit, 0–100 % (0 when absent). */
export const alignPitch = (e: AlignEdit): number => e.pitch ?? 0;
/** The strength of a grid-mode edit, 0–100 % (the default when absent). */
export const alignStrength = (e: AlignEdit): number => e.strength ?? DEFAULT_GRID_STRENGTH;
/** Ticks between the grid lines of a grid-mode edit. */
export const alignStepTicks = (e: AlignEdit): number => e.stepTicks ?? DEFAULT_GRID_STEP_TICKS;

/**
 * The sound the clip's later steps work on: the alignment's render when it has one, else the channel's own sample. The
 * Pitch editor analyses and renders from this, so its notes sit on the aligned sound (align first, then tune).
 */
export function alignedSampleId(channel: Pick<AudioClipChannel, 'sampleId'>, clip: Pick<AudioClip, 'align'> | undefined): SampleId {
  return clip?.align?.renderedSampleId ?? channel.sampleId;
}

/** True when the clip has an alignment whose render the clip plays. */
export function hasAlignRender(clip: Pick<AudioClip, 'align'>): boolean {
  return !!clip.align?.renderedSampleId;
}

/** A short line about what an alignment does, for the clip's tag and the readouts ("Aligned to guide, tightness 70"). */
export function describeAlign(e: AlignEdit): string {
  if (e.mode === 'grid') return `Tightened to the grid, ${Math.round(alignStrength(e))} %`;
  const pitch = alignPitch(e);
  return `Aligned to a guide, tightness ${Math.round(e.tightness)}${pitch > 0 ? `, pitch ${Math.round(pitch)} %` : ''}`;
}

/**
 * Reads an alignment from data that may be damaged (a project file, the AI): numbers are clamped, unknown modes and
 * unreadable data give null, and the warp is kept only when it is a sensible list of points.
 */
export function sanitizeAlignEdit(v: unknown): AlignEdit | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Record<string, unknown>;
  if (raw.mode !== 'guide' && raw.mode !== 'grid') return null;
  const edit: AlignEdit = { mode: raw.mode, tightness: clamp(finite(raw.tightness) ? raw.tightness : DEFAULT_TIGHTNESS, 0, 100) };
  if (raw.mode === 'guide') {
    if (typeof raw.guide !== 'string' || raw.guide === '') return null;
    edit.guide = raw.guide as AlignEdit['guide'];
    if (finite(raw.pitch) && raw.pitch > 0) edit.pitch = clamp(raw.pitch, 0, 100);
  } else {
    edit.strength = clamp(finite(raw.strength) ? raw.strength : DEFAULT_GRID_STRENGTH, 0, 100);
    if (finite(raw.stepTicks) && raw.stepTicks >= 1) edit.stepTicks = Math.round(raw.stepTicks);
  }
  if (typeof raw.renderedSampleId === 'string' && raw.renderedSampleId !== '') edit.renderedSampleId = raw.renderedSampleId as SampleId;
  if (typeof raw.renderedFor === 'string') edit.renderedFor = raw.renderedFor;
  const warp = sanitizeWarp(raw.warp);
  if (warp) edit.warp = warp;
  return edit;
}

/** A flat `[sampleSec, moveMs, …]` list of finite numbers (even length, at most `MAX_WARP_POINTS` points), or null. */
function sanitizeWarp(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length < 4 || v.length % 2 !== 0 || v.length > 2 * MAX_WARP_POINTS) return null;
  if (!v.every(finite)) return null;
  for (let i = 2; i < v.length; i += 2) if ((v[i] as number) < (v[i - 2] as number)) return null;
  return v as number[];
}

/**
 * The signature of a clip's pitch edit as its render sees it: the edit's own signature, plus the sound the pitch stage
 * reads when an earlier stage of the clip edit chain (cleanup, alignment) made one (`clipSourceSampleId(…, 'pitch')`), so
 * the pitch render is out of date as soon as that sound changes. Without an earlier render it is exactly `editSignature`,
 * so projects with only a pitch edit keep their renders.
 */
export function pitchRenderSignature(
  channel: Pick<AudioClipChannel, 'sampleId'>,
  clip: Pick<AudioClip, 'pitchEdit' | 'align' | 'cleanup'>,
): string | null {
  if (!clip.pitchEdit) return null;
  const base = editSignature(clip.pitchEdit);
  const source = clipSourceSampleId(channel, clip, 'pitch');
  return source !== channel.sampleId ? `${base}|from:${source}` : base;
}
