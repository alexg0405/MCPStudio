import type { Draft } from 'immer';
import type { AlignEdit, ClipId, Project, SampleId, SampleRef } from '../model/types';

// Draft mutators for a clip's vocal alignment (AudioClip.align). The dialog, the AI and the renderer all go through
// these, inside History transactions.

/** True when some clip (other than `except`) plays `sampleId` as the render of its alignment or pitch correction, or a channel has it. */
function renderInUse(d: Draft<Project>, sampleId: SampleId, except?: ClipId): boolean {
  for (const c of Object.values(d.playlist.clips)) {
    if (c.kind !== 'audio' || c.id === except) continue;
    if (c.align?.renderedSampleId === sampleId || c.pitchEdit?.renderedSampleId === sampleId) return true;
  }
  const own = except ? d.playlist.clips[except] : undefined;
  if (own?.kind === 'audio' && own.pitchEdit?.renderedSampleId === sampleId) return true;
  for (const ch of Object.values(d.channels)) if (ch.kind === 'audioClip' && ch.sampleId === sampleId) return true;
  return false;
}

/** Forgets a render's sample entry once nothing plays it (its audio is cleaned up with other unused audio). */
function dropRender(d: Draft<Project>, sampleId: SampleId | undefined, except?: ClipId): void {
  if (sampleId && d.samples[sampleId] && !renderInUse(d, sampleId, except)) delete d.samples[sampleId];
}

/**
 * Sets a clip's alignment (null removes it). The settings come from `edit`; the render the clip already has stays until
 * a new one is made (it is marked out of date by its signature), so the clip keeps playing the earlier alignment while
 * the new one is being made.
 */
export function setAlign(d: Draft<Project>, clipId: ClipId, edit: AlignEdit | null): void {
  const clip = d.playlist.clips[clipId];
  if (clip?.kind !== 'audio') return;
  const had = clip.align?.renderedSampleId;
  if (!edit) {
    delete clip.align;
    dropRender(d, had, clipId);
    return;
  }
  const next: AlignEdit = { mode: edit.mode, tightness: edit.tightness };
  if (edit.guide !== undefined) next.guide = edit.guide;
  if (edit.pitch !== undefined && edit.pitch > 0) next.pitch = edit.pitch;
  if (edit.strength !== undefined) next.strength = edit.strength;
  if (edit.stepTicks !== undefined) next.stepTicks = edit.stepTicks;
  const keep = clip.align;
  if (keep?.renderedSampleId) {
    next.renderedSampleId = keep.renderedSampleId;
    if (keep.renderedFor !== undefined) next.renderedFor = keep.renderedFor;
    if (keep.warp) next.warp = [...keep.warp];
  }
  clip.align = next;
}

/**
 * Records the render of a clip's alignment: its sample becomes the clip's sound, the one it had before goes when nothing
 * plays it any more. `warp` is the overlay's points (see `warpKnots`).
 */
export function setAlignRender(d: Draft<Project>, clipId: ClipId, sample: SampleRef, signature: string, warp: readonly number[]): void {
  const clip = d.playlist.clips[clipId];
  if (clip?.kind !== 'audio' || !clip.align) return;
  const old = clip.align.renderedSampleId;
  d.samples[sample.id] = sample as Draft<SampleRef>;
  clip.align.renderedSampleId = sample.id;
  clip.align.renderedFor = signature;
  clip.align.warp = [...warp];
  if (old && old !== sample.id) dropRender(d, old, clipId);
}

/** The clip plays its channel's own audio again (the settings stay). */
export function clearAlignRender(d: Draft<Project>, clipId: ClipId): void {
  const clip = d.playlist.clips[clipId];
  if (clip?.kind !== 'audio' || !clip.align?.renderedSampleId) return;
  const old = clip.align.renderedSampleId;
  delete clip.align.renderedSampleId;
  delete clip.align.renderedFor;
  delete clip.align.warp;
  dropRender(d, old, clipId);
}
