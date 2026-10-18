/**
 * Listening to the mix: the offline render and measurement behind "Check my mix", and "Balance the mix"
 * (which levels the song without asking an AI).
 */
import { inferStyle } from '@core/beat/style';
import { formatMixReport, summarizeMixReport, type AnalyzeRange } from '../../analysis/mix';
import type { ResolvedFocus } from '../../ai/focus';
import { errorText, isAbortError } from './errors';
import { runFollowUpSteps } from './follow-up-steps';
import type { AssistantSession } from './session';

/** What "Check my mix" asks the AI, along with the measurements. */
export const CHECK_MIX_REQUEST =
  'Listen to my mix and make it sound better: balance the levels, fix what clashes or sounds harsh, muddy or thin, and get the master to a good loudness without clipping. Tell me what you changed and why.';

/** The span of the song to measure: the part's pattern or bars, or null for the whole song. */
function rangeOf(part: ResolvedFocus | null): AnalyzeRange | undefined {
  if (!part) return undefined;
  if (part.notes) return { patternId: part.notes.patternId };
  return { from: part.from, to: part.to };
}

/**
 * Renders and measures the mix (every mixer track too) and tells the musician what it found. Returns the
 * report as text for the AI, or null when it failed or was stopped (that is already in the chat, and the
 * request is over). `signal` stops the render.
 */
export async function listenToMix(
  session: AssistantSession,
  part: ResolvedFocus | null,
  signal: AbortSignal,
): Promise<string | null> {
  const { store } = session;
  const range = rangeOf(part);
  store.setState({ phase: 'listening', listening: { label: 'The mix', fraction: 0 } });
  try {
    const report = await session.analyzeMix(session.services, {
      signal,
      onProgress: (fraction, label) => store.setState({ listening: { label, fraction } }),
      ...(range ? { range } : {}),
    });
    const analysis = formatMixReport(report);
    session.say('assistant', `I listened to ${report.what}.`, {
      detail: summarizeMixReport(report),
      ...(report.notes.length ? { findings: report.notes } : {}),
    });
    return analysis;
  } catch (error) {
    const stopped = isAbortError(error);
    session.say('assistant', stopped ? 'Stopped.' : `I couldn't listen to the mix: ${errorText(error)}`, {
      ...(stopped ? {} : { error: true }),
    });
    store.setState({ phase: 'idle', listening: null });
    session.abort = null;
    return null;
  }
}

/**
 * "Balance the mix": levels the song without an AI (auto-level: the role buses around the kick, or for a
 * mix built by hand just its loudness), one undo step, with progress in the Studio. It waits while the song
 * plays.
 */
export async function balanceMix(session: AssistantSession): Promise<void> {
  if (session.store.getState().phase !== 'idle') return;
  const style = inferStyle(session.services.doc.getState().project);
  await runFollowUpSteps(session, [{ kind: 'level_mix', style }], null);
}
