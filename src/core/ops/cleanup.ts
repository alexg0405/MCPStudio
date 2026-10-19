import type { Draft } from 'immer';
import { isNeutralCleanup } from '../audio/cleanup-edit';
import type { BreathSpan, Clip, ClipId, Project, SampleId, SampleRef, VocalCleanup } from '../model/types';

// Draft mutators for a clip's vocal cleanup (AudioClip.cleanup). The window, the AI and the render all go through
// these, inside History transactions.

/** True when some clip (other than `except`) still plays `sampleId` as a render of its cleanup or pitch edit, or a channel plays it. */
function renderInUse(d: Draft<Project>, sampleId: SampleId, except?: ClipId): boolean {
  for (const c of Object.values(d.playlist.clips)) {
    if (c.kind !== 'audio' || c.id === except) continue;
    if (c.cleanup?.renderedSampleId === sampleId || c.pitchEdit?.renderedSampleId === sampleId) return true;
  }
  for (const ch of Object.values(d.channels)) if (ch.kind === 'audioClip' && ch.sampleId === sampleId) return true;
  return false;
}

/** Forgets a render's sample entry once nothing plays it (its audio is cleaned up with other unused audio). */
function dropRender(d: Draft<Project>, sampleId: SampleId | undefined, except?: ClipId): void {
  if (sampleId && d.samples[sampleId] && !renderInUse(d, sampleId, except)) delete d.samples[sampleId];
}

/**
 * The clip's pitch render was made from the sound the cleanup rendered (or from the recording, with no cleanup): when
 * that source changes the pitch render is out of date, and clearing its `renderedFor` is what makes the pitch
 * renderer make it again. The render stays in place (it plays) until the new one is ready.
 */
function pitchRenderIsStale(clip: Draft<Clip> | undefined): void {
  if (clip?.kind === 'audio' && clip.pitchEdit?.renderedSampleId) delete clip.pitchEdit.renderedFor;
}

/**
 * Sets a clip's cleanup (null removes it). The render the clip already has stays until a new one is made (it is
 * marked out of date by its signature), unless the settings change nothing, when the clip goes back to the
 * recording's own sound and the pitch render is made again from it.
 */
export function setCleanup(d: Draft<Project>, clipId: ClipId, cleanup: VocalCleanup | null): void {
  const clip = d.playlist.clips[clipId];
  if (clip?.kind !== 'audio') return;
  const had = clip.cleanup?.renderedSampleId;
  const hadFor = clip.cleanup?.renderedFor;
  if (!cleanup || isNeutralCleanup(cleanup)) {
    delete clip.cleanup;
    if (had) {
      pitchRenderIsStale(clip);
      dropRender(d, had, clipId);
    }
    return;
  }
  const next: VocalCleanup = {};
  if (cleanup.noise) next.noise = { ...cleanup.noise };
  if (cleanup.breaths) next.breaths = { ...cleanup.breaths, ...(cleanup.breaths.spans ? { spans: cleanup.breaths.spans.map((s) => ({ ...s })) } : {}) };
  if (cleanup.clicks) next.clicks = { ...cleanup.clicks };
  if (had) {
    next.renderedSampleId = had;
    if (hadFor !== undefined) next.renderedFor = hadFor;
  }
  clip.cleanup = next;
}

/** What a render found, to be written with it so the same render can be made again. */
export interface CleanupFound {
  /** The quiet stretch the noise was learned from. */
  noise?: { from: number; to: number };
  /** The breaths found. */
  breaths?: BreathSpan[];
}

/**
 * Records the render of a clip's cleanup: its sample becomes the clip's (or the pitch edit's) source, the one it had
 * before goes when nothing plays it any more, and what the render found (the quiet stretch, the breaths) is written
 * into the settings when they had none. A pitch render made from the old source is marked out of date.
 */
export function setCleanupRender(d: Draft<Project>, clipId: ClipId, sample: SampleRef, signature: string, found: CleanupFound): void {
  const clip = d.playlist.clips[clipId];
  if (clip?.kind !== 'audio' || !clip.cleanup) return;
  const old = clip.cleanup.renderedSampleId;
  const noise = clip.cleanup.noise;
  if (noise && found.noise && (noise.from === undefined || noise.to === undefined)) {
    noise.from = found.noise.from;
    noise.to = found.noise.to;
  }
  const breaths = clip.cleanup.breaths;
  if (breaths && found.breaths && !breaths.spans) breaths.spans = found.breaths.map((s) => ({ ...s }));
  d.samples[sample.id] = sample as Draft<SampleRef>;
  clip.cleanup.renderedSampleId = sample.id;
  clip.cleanup.renderedFor = signature;
  if (old !== sample.id) pitchRenderIsStale(clip);
  if (old && old !== sample.id) dropRender(d, old, clipId);
}

/** The clip plays the recording's own sound again (the settings stay). */
export function clearCleanupRender(d: Draft<Project>, clipId: ClipId): void {
  const clip = d.playlist.clips[clipId];
  if (clip?.kind !== 'audio' || !clip.cleanup?.renderedSampleId) return;
  const old = clip.cleanup.renderedSampleId;
  delete clip.cleanup.renderedSampleId;
  delete clip.cleanup.renderedFor;
  pitchRenderIsStale(clip);
  dropRender(d, old, clipId);
}

/** Switches one found breath on or off (index into the breaths found); the render becomes out of date. Returns false when there is no such breath. */
export function setBreathOff(d: Draft<Project>, clipId: ClipId, index: number, off: boolean): boolean {
  const clip = d.playlist.clips[clipId];
  const span = clip?.kind === 'audio' ? clip.cleanup?.breaths?.spans?.[index] : undefined;
  if (!span) return false;
  if (off) span.off = true;
  else delete span.off;
  return true;
}
