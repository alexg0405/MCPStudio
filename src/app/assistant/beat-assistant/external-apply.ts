/**
 * Edits from AI apps over MCP (`src/app/mcp`): the same applier as an answer from Studio, one undo step
 * labelled with the app's name, and a message in this chat ("Claude Code changed: …") with the usual Undo.
 */
import { applyAnswer, type AppliedTurn } from '../../ai/apply';
import { resolveFocus, type ResolvedFocus } from '../../ai/focus';
import { formatLookups } from '../../ai/read';
import type { AiAnswer } from '../../ai/schema';
import type { ExternalApplied, ExternalApply } from '../state';
import {
  applyRequestedPlayback,
  beatMessageFields,
  runCommands,
  waitForNewSounds,
  type CommandReport,
} from './answer-effects';
import { runFollowUpSteps } from './follow-up-steps';
import { buildPlugin } from './plugin-building';
import type { AssistantSession } from './session';

/** How long (ms) an AI app's edit waits for the Studio to finish another request before answering "busy". */
const BUSY_WAIT_MS = 15_000;
/** How long (ms) the follow-up steps wait for the musician to stop the music before giving up. */
const FOLLOW_UP_QUIET_WAIT_MS = 30_000;

/** A line in this chat about something an AI app did (a command, an undo…), with an Undo when it changed the project. */
export function reportExternal(
  session: AssistantSession,
  client: string,
  text: string,
  extra: { undo?: number; changes?: string[]; warnings?: string[] } = {},
): void {
  session.say('assistant', `${client} ${text}`, { detail: 'over MCP', ...extra });
}

/** "Claude Code changed: …": what the chat says about the edit. */
function externalVerb(result: AppliedTurn, changeCount: number): string {
  if (result.edited) return 'changed';
  return changeCount ? 'did' : 'tried to change';
}

/**
 * Applies actions an AI app sent over MCP. With a focus, edits outside the part wait for `approveOutside`.
 * Playback only changes when the actions ask for it. Resolves when the follow-up steps (leveling…) are done.
 */
export async function applyExternal(
  session: AssistantSession,
  answer: AiAnswer,
  options: ExternalApply,
): Promise<ExternalApplied> {
  const { services, store } = session;
  const beforePoint = services.history.status().cursor;
  const nothingChanged: ExternalApplied = {
    status: 'applied',
    changes: [],
    warnings: [],
    edited: false,
    beforePoint,
    undoPoint: null,
    followups: [],
  };
  if (!(await session.untilIdle(BUSY_WAIT_MS))) {
    return {
      ...nothingChanged,
      status: 'busy',
      warnings: ['Studio is busy with another request. Try again in a moment.'],
    };
  }
  const part = resolveFocus(services.doc.getState().project, options.focus ?? null);
  const applyContext = {
    previousBeat: part?.notes ? null : store.getState().applied,
    label: options.summary,
    source: options.client,
    focus: part,
  };
  const needsApproval = outsideTheFocus(session, answer, applyContext, part, options, nothingChanged);
  if (needsApproval) return needsApproval;

  const result = applyAnswer(services, answer, {
    ...applyContext,
    ...(part ? { focusOutside: options.approveOutside ? ('allow' as const) : ('refuse' as const) } : {}),
  });
  const cursor = services.history.status().cursor;
  const report = reportToChat(session, answer, result, options, cursor);

  const followups: string[] = [];
  if (options.waitForFollowups !== false) {
    await runFollowUpSteps(session, result.after, result.edited ? cursor : null, {
      quietWaitMs: FOLLOW_UP_QUIET_WAIT_MS,
      onResult: (stepResult) =>
        followups.push(
          stepResult.message,
          ...(stepResult.changes ?? []),
          ...(stepResult.warnings ?? []).map((warning) => `Could not: ${warning}`),
        ),
    });
  }
  const undoPoint = services.history.status().cursor;
  // Playback the actions asked for (nothing else starts or stops the music).
  if (result.edited) await waitForNewSounds(services);
  applyRequestedPlayback(services, result.after, { canArmRecording: false });
  for (const action of result.after) if (action.kind === 'build_plugin') void buildPlugin(session, action.spec);

  const changedProject = undoPoint !== beforePoint;
  return {
    status: 'applied',
    changes: report.changes,
    warnings: report.warnings,
    edited: result.edited || changedProject,
    beforePoint,
    undoPoint: changedProject ? undoPoint : null,
    followups,
    ...(result.findings?.length ? { findings: result.findings } : {}),
    // Query actions: what the read tools returned (an AI app can also call them itself).
    ...(result.queries?.length ? { lookups: formatLookups(result.queries) } : {}),
  };
}

/**
 * Runs the commands the actions asked for, tells the chat what the app did (with an Undo when it changed the
 * project) and points the UI at the windows and clips the answer picked. Returns the lines for the app.
 */
function reportToChat(
  session: AssistantSession,
  answer: AiAnswer,
  result: AppliedTurn,
  options: ExternalApply,
  cursor: number,
): CommandReport {
  const { services, store } = session;
  const report = { changes: [...result.changes, ...(result.ui ?? [])], warnings: [...result.warnings] };
  // App commands: most run now; file dialogs need the musician's click (the app shows a button).
  runCommands(services, result.after, report, {
    waitingNote: (title) => `${title}: waiting for the musician's click`,
    onGesture: (command) => options.onGesture?.(command.id, command.args),
  });
  const summary = options.summary.trim() || answer.message.trim();
  session.say(
    'assistant',
    `${options.client} ${externalVerb(result, report.changes.length)}: ${summary || 'the project'}`,
    {
      detail: 'over MCP',
      ...(report.changes.length ? { changes: report.changes } : {}),
      ...(report.warnings.length ? { warnings: report.warnings } : {}),
      ...(result.edited ? { undo: cursor } : {}),
      ...beatMessageFields(services, result.beat, cursor),
    },
  );
  if (result.beat) store.setState({ applied: result.beat });
  const windows = result.after.filter((action) => action.kind === 'open');
  if (windows.length) store.setState({ uiRequests: windows });
  if (result.selectClips?.length) services.editor.getState().selectClips(result.selectClips);
  return report;
}

/**
 * Working on a part, an edit that also reaches outside it waits for the app to say it is allowed: the reply
 * to send instead of applying (nothing was changed), or null when the edit may go ahead.
 */
function outsideTheFocus(
  session: AssistantSession,
  answer: AiAnswer,
  applyContext: Parameters<typeof applyAnswer>[2],
  part: ResolvedFocus | null,
  options: ExternalApply,
  nothingChanged: ExternalApplied,
): ExternalApplied | null {
  if (!part || options.approveOutside) return null;
  const dryRun = applyAnswer(session.services, answer, { ...applyContext, dryRun: true });
  if (!dryRun.outsideFocus?.length) return null;
  return {
    ...nothingChanged,
    status: 'needs_approval',
    part: part.label,
    outside: [...new Set(dryRun.outsideFocus)],
    warnings: dryRun.warnings,
  };
}
