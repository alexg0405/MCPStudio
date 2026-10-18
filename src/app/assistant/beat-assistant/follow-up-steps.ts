/**
 * Runs the follow-up steps of an applied answer (see `../after-steps.ts`: leveling the mix, filters, reference
 * matching…) with progress in the chat, one after the other.
 */
import type { AfterEdit } from '../../ai/apply';
import { afterStepFor, type AfterStepResult } from '../after-steps';
import { errorText, isAbortError } from './errors';
import type { AssistantSession } from './session';

/** The progress line while a step waits for the musician to stop the music. */
const WAITING_FOR_PLAYBACK_LABEL = 'Waiting while you listen (stop playback to finish)';
/** The progress line before a step has said what it is doing. */
const DEFAULT_PROGRESS_LABEL = 'Finishing up';

/** How a run of follow-up steps is driven. */
export interface FollowUpOptions {
  /** Give up waiting for the music to stop after this long (ms): an AI app is waiting for the answer. */
  quietWaitMs?: number;
  /** Called with each step's result as it arrives. */
  onResult?(result: AfterStepResult): void;
}

/**
 * Runs the answer's follow-up steps with progress; Stop cancels them. Their heavy work waits while the
 * musician plays the song (rendering next to playback makes it choppy). `entry` is the answer's undo entry,
 * or null when it changed nothing itself. True when the musician started playback meanwhile.
 */
export async function runFollowUpSteps(
  session: AssistantSession,
  after: readonly AfterEdit[],
  entry: number | null,
  options: FollowUpOptions = {},
): Promise<boolean> {
  const steps = after.filter((action) => afterStepFor(action.kind));
  if (steps.length === 0) return false;
  const { services, store } = session;

  let musicianStartedPlayback = services.engine.playing;
  const stopWatchingPlayback = services.engine.subscribe(() => {
    if (services.engine.playing) musicianStartedPlayback = true;
  });

  const progress = { label: DEFAULT_PROGRESS_LABEL, fraction: 0 };
  const showProgress = () => store.setState({ listening: { label: progress.label, fraction: progress.fraction } });

  /** Resolves when nothing is playing (at once when nothing is), or after `quietWaitMs`. */
  const whenQuiet = () =>
    new Promise<void>((resolve) => {
      if (!services.engine.playing) return resolve();
      store.setState({ listening: { label: WAITING_FOR_PLAYBACK_LABEL, fraction: progress.fraction } });
      const finish = () => {
        unsubscribe();
        clearTimeout(giveUp);
        showProgress();
        resolve();
      };
      const unsubscribe = services.engine.subscribe(() => {
        if (!services.engine.playing) finish();
      });
      const giveUp = options.quietWaitMs === undefined ? undefined : setTimeout(finish, options.quietWaitMs);
    });

  const abort = new AbortController();
  session.abort = abort;
  store.setState({ phase: 'listening', listening: { label: DEFAULT_PROGRESS_LABEL, fraction: 0 } });
  try {
    // The answer's undo step; when it changed nothing itself (a request that is only leveling or a
    // filter), the first step that edits makes it, and the steps after it join it.
    let undoEntry = entry;
    for (const step of steps) {
      const cursorBefore = services.history.status().cursor;
      const result = await afterStepFor(step.kind)!(step, {
        s: services,
        entry: undoEntry,
        signal: abort.signal,
        progress: (label, fraction) => {
          progress.label = label;
          progress.fraction = fraction;
          if (!services.engine.playing) showProgress();
        },
        whenQuiet,
      });
      const cursorAfter = services.history.status().cursor;
      const madeTheUndoStep = undoEntry === null && cursorAfter !== cursorBefore;
      if (madeTheUndoStep) undoEntry = cursorAfter;
      if (!result) continue;
      options.onResult?.(result);
      session.say('assistant', result.message, {
        ...(result.changes?.length ? { changes: result.changes } : {}),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        ...(madeTheUndoStep ? { undo: cursorAfter } : {}),
      });
    }
  } catch (error) {
    if (!isAbortError(error)) session.say('assistant', `I couldn't finish: ${errorText(error)}`, { error: true });
  } finally {
    stopWatchingPlayback();
    if (session.abort === abort) session.abort = null;
    store.setState({ phase: 'idle', listening: null });
  }
  return musicianStartedPlayback;
}
