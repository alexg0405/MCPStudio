/** What the harmony commands, menus and dialog do: find the lead clip, run the work, say what happened. */
import type { Services } from '@app/services';
import { audioClipsFor } from '@app/actions/audio-clips';
import { HarmonyError, makeHarmonies, staleHarmonyCount, updateHarmonies, type HarmonyResult, type UpdateOptions } from '@app/harmony/voices';
import { HarmonySpecError, type HarmonySpec } from '@app/harmony/voice-spec';
import { specFromArgs } from '@app/harmony/voice-args';
import { harmonyVoices } from '@core/query/harmony-voices';
import type { AudioClip, ClipId } from '@core/model/types';

export { specFromArgs };

/** The audio clip a command is about: `{ clip }`, else the selected audio clip (null when there is none). */
export function leadClipOf(s: Services, args: unknown): AudioClip | null {
  const id = args && typeof args === 'object' ? (args as { clip?: unknown }).clip : undefined;
  return audioClipsFor(s, typeof id === 'string' ? [id as ClipId] : undefined)[0] ?? null;
}

/** The words of a failed run: plain, for a toast. */
function problemText(e: unknown): string {
  return e instanceof HarmonyError || e instanceof HarmonySpecError || e instanceof Error ? e.message : String(e);
}

/** Runs a job with a start toast and the result (or the problem) as a toast. Resolves with what it did, or null when it failed. */
async function withToasts(s: Services, start: string, job: () => Promise<HarmonyResult>): Promise<HarmonyResult | null> {
  const session = s.session.getState();
  session.toast(start);
  try {
    const result = await job();
    session.toast(result.message);
    return result;
  } catch (e) {
    session.toast(problemText(e), 'error');
    return null;
  }
}

/** Makes harmonies with toasts for the start and the result. */
export function runMake(s: Services, clipId: ClipId, spec: HarmonySpec): Promise<HarmonyResult | null> {
  return withToasts(s, 'Listening to the lead and making the harmonies…', () => makeHarmonies(s, clipId, spec));
}

/** Updates harmonies with toasts for the start and the result. */
export function runUpdate(s: Services, opts: UpdateOptions = {}): Promise<HarmonyResult | null> {
  return withToasts(s, 'Updating the harmonies…', () => updateHarmonies(s, opts));
}

/** Whether the project has any harmony voices. */
export const hasHarmonies = (s: Services): boolean => harmonyVoices(s.doc.getState().project).length > 0;

/** How many harmony voices need an update, for hints and menu labels. */
export const staleCount = (s: Services): number => staleHarmonyCount(s.doc.getState().project);
