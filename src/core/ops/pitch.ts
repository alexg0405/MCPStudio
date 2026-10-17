import type { Draft } from 'immer';
import { isNeutralEdit } from '../audio/pitch-edit';
import type { ClipId, PitchEdit, Project, SampleId, SampleRef } from '../model/types';

// Draft mutators for a clip's pitch correction (AudioClip.pitchEdit). The editor, the AI and the
// render all go through these, inside History transactions.

/** True when some clip (other than `except`) still plays `sampleId` as the render of its pitch edit. */
function renderInUse(d: Draft<Project>, sampleId: SampleId, except?: ClipId): boolean {
  for (const c of Object.values(d.playlist.clips)) {
    if (c.kind === 'audio' && c.id !== except && c.pitchEdit?.renderedSampleId === sampleId) return true;
  }
  for (const ch of Object.values(d.channels)) if (ch.kind === 'audioClip' && ch.sampleId === sampleId) return true;
  return false;
}

/** Forgets a render's sample entry once nothing plays it (its audio is cleaned up with other unused audio). */
function dropRender(d: Draft<Project>, sampleId: SampleId | undefined, except?: ClipId): void {
  if (sampleId && d.samples[sampleId] && !renderInUse(d, sampleId, except)) delete d.samples[sampleId];
}

/**
 * Sets a clip's pitch edit (null removes it). The notes and settings come from `edit`; the render
 * the clip already has stays until a new one is made (it is marked out of date by its signature),
 * unless the edit changes nothing, when the clip goes back to the channel's own audio.
 */
export function setPitchEdit(d: Draft<Project>, clipId: ClipId, edit: PitchEdit | null): void {
  const clip = d.playlist.clips[clipId];
  if (clip?.kind !== 'audio') return;
  const had = clip.pitchEdit?.renderedSampleId;
  const hadFor = clip.pitchEdit?.renderedFor;
  if (!edit) {
    delete clip.pitchEdit;
    dropRender(d, had, clipId);
    return;
  }
  const next: PitchEdit = { notes: edit.notes.map((n) => ({ ...n })) };
  if (edit.transition !== undefined) next.transition = edit.transition;
  if (had && !isNeutralEdit(next)) {
    next.renderedSampleId = had;
    if (hadFor !== undefined) next.renderedFor = hadFor;
  }
  clip.pitchEdit = next;
  if (had && !next.renderedSampleId) dropRender(d, had, clipId);
}

/**
 * Records the render of a clip's pitch edit: its sample becomes the clip's audio, the one it had
 * before goes when nothing plays it any more.
 */
export function setPitchRender(d: Draft<Project>, clipId: ClipId, sample: SampleRef, signature: string): void {
  const clip = d.playlist.clips[clipId];
  if (clip?.kind !== 'audio' || !clip.pitchEdit) return;
  const old = clip.pitchEdit.renderedSampleId;
  d.samples[sample.id] = sample as Draft<SampleRef>;
  clip.pitchEdit.renderedSampleId = sample.id;
  clip.pitchEdit.renderedFor = signature;
  if (old && old !== sample.id) dropRender(d, old, clipId);
}

/** The clip plays its channel's own audio again (the edit stays). */
export function clearPitchRender(d: Draft<Project>, clipId: ClipId): void {
  const clip = d.playlist.clips[clipId];
  if (clip?.kind !== 'audio' || !clip.pitchEdit?.renderedSampleId) return;
  const old = clip.pitchEdit.renderedSampleId;
  delete clip.pitchEdit.renderedSampleId;
  delete clip.pitchEdit.renderedFor;
  dropRender(d, old, clipId);
}
