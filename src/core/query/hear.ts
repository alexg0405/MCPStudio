/**
 * What the engine plays when the musician is only listening differently: one take on its own (comping) or a clip's
 * original recording instead of its pitch-corrected render (the Pitch editor's A/B). The document is never touched:
 * these are copies of the project for the engine, memoized by project, and the same project comes back when there is
 * nothing to change. Session state decides the copy (`EditorState.auditionTake`, `pitchOriginal`).
 */
import { produce } from 'immer';
import type { ClipId, Project } from '../model/types';
import { auditionProject } from './takes';

export interface Listening {
  /** The take clip heard on its own, or null. */
  audition: ClipId | null;
  /** Audio clips that play their original recording although they have a corrected render. */
  original: readonly ClipId[];
}

const originalCache = new WeakMap<object, Map<string, Project>>();

/** True when the clip has a corrected render that A/B can switch away from. */
export function hasPitchRender(project: Project, id: ClipId): boolean {
  const c = project.playlist.clips[id];
  return c?.kind === 'audio' && !!c.pitchEdit?.renderedSampleId;
}

/** The project with these clips playing their own recording (no render). Returns `project` when none has a render. */
export function originalSound(project: Project, ids: readonly ClipId[]): Project {
  const wanted = ids.filter((id) => hasPitchRender(project, id));
  if (wanted.length === 0) return project;
  const key = [...wanted].sort().join('|');
  let byKey = originalCache.get(project);
  if (!byKey) originalCache.set(project, (byKey = new Map()));
  let v = byKey.get(key);
  if (!v) {
    v = produce(project, (d) => {
      for (const id of wanted) {
        const c = d.playlist.clips[id];
        if (c?.kind === 'audio' && c.pitchEdit) delete c.pitchEdit.renderedSampleId;
      }
    });
    byKey.set(key, v);
  }
  return v;
}

/** The project as the engine should play it for the current way of listening. */
export function heardProject(project: Project, listening: Listening): Project {
  return originalSound(auditionProject(project, listening.audition), listening.original);
}
