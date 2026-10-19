/** Repair of an audio clip's vocal cleanup (`AudioClip.cleanup`), called from the playlist repair. */
import { sanitizeCleanup } from '../../audio/cleanup-edit';
import { hasOwn, isObject, type JsonObject } from '../json-values';

/** How many spans the cleanup of a clip had, to tell whether sanitizing dropped any. */
function spanCount(cleanup: unknown): number {
  if (!isObject(cleanup) || !isObject(cleanup.breaths) || !Array.isArray(cleanup.breaths.spans)) return -1;
  return cleanup.breaths.spans.length;
}

/**
 * The clip's cleanup is cleaned (ranges, spans in order); a render that is not in the samples is forgotten, so the
 * clip plays its recording until it is made again. True when anything was changed.
 */
export function repairCleanup(clip: JsonObject, samples: JsonObject): boolean {
  const original = clip.cleanup;
  const cleanup = sanitizeCleanup(original);
  if (!cleanup) {
    delete clip.cleanup;
    return true;
  }
  let wasFixed = spanCount(original) !== spanCount(cleanup);
  if (cleanup.renderedSampleId && !hasOwn(samples, cleanup.renderedSampleId)) {
    delete cleanup.renderedSampleId;
    delete cleanup.renderedFor;
    wasFixed = true;
  }
  clip.cleanup = cleanup as unknown as JsonObject;
  return wasFixed;
}
