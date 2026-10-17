/**
 * The reference as a document edit (a draft inside one History recipe): put it in, take it out. The
 * song file becomes (or is found among) the project's samples so its audio stays in the project's
 * storage for display and re-analysis; no channel or clip ever plays it.
 */
import { current, isDraft, type Draft } from 'immer';
import type { Project, ReferenceTrack, SampleRef } from '@core/model/types';
import { sampleHash } from '../dj/analyzer';

/** The project's sample for a file (by content hash), if it already has one. */
export function sampleByHash(p: Project, hash: string): SampleRef | undefined {
  return Object.values(p.samples).find((x) => x.source.kind === 'embedded' && x.source.hash === hash);
}

const plain = <T extends object>(x: T): T => (isDraft(x) ? (current(x as Draft<T>) as T) : x);

/** Whether anything but the sample list and the reference mentions a sample (a channel, a plugin slot, a DJ mix). */
export function sampleUsedElsewhere(p: Project, id: string): boolean {
  const rest = { ...p, samples: undefined, reference: undefined };
  return JSON.stringify(rest).includes(id);
}

/**
 * Sets the reference. A file the project does not have yet joins its samples; the sample of the
 * reference it replaces leaves them when nothing else uses it. Returns the stored track.
 */
export function setReferenceInDraft(d: Draft<Project>, track: ReferenceTrack, sample: SampleRef | null): ReferenceTrack {
  const p = plain(d) as unknown as Project;
  const mine = sample ? (sampleByHash(p, sampleHash(sample) ?? '') ?? sample) : track.sampleId ? p.samples[track.sampleId] : undefined;
  const old = d.reference?.sampleId;
  if (mine && !p.samples[mine.id]) d.samples[mine.id] = mine as Draft<SampleRef>;
  const stored: ReferenceTrack = { ...track };
  if (mine) stored.sampleId = mine.id;
  else delete stored.sampleId;
  d.reference = stored as Draft<ReferenceTrack>;
  if (old && old !== mine?.id && d.samples[old] && !sampleUsedElsewhere(plain(d) as unknown as Project, old)) delete d.samples[old];
  return stored;
}

/** Removes the reference (and its sample when nothing else uses it). False when there was none. */
export function clearReferenceInDraft(d: Draft<Project>): boolean {
  if (!d.reference) return false;
  const old = d.reference.sampleId;
  delete d.reference;
  if (old && d.samples[old] && !sampleUsedElsewhere(plain(d) as unknown as Project, old)) delete d.samples[old];
  return true;
}
