/**
 * The loop of one request once the AI has answered: apply the answer as one undo step and report it, then
 * (when the answer asked for it) look things up or listen to the mix and ask again with what was found.
 * These steps call each other, so they live together.
 */
import { ticksPerBar } from '@core/time/ppq';
import { applyAnswer, type AfterEdit } from '../../ai/apply';
import { resolveFocus, type AiFocus, type ResolvedFocus } from '../../ai/focus';
import { formatLookups } from '../../ai/read';
import type { AiAnswer } from '../../ai/schema';
import { playFocus } from '../play-focus';
import type { ApprovalMessage, Take } from '../state';
import { audition } from '../audition';
import { askStudio, buildTurnText } from './ask-studio';
import {
  applyRequestedPlayback,
  beatMessageFields,
  runCommands,
  startDeckActions,
  waitForNewSounds,
} from './answer-effects';
import { errorText, isAbortError } from './errors';
import { runFollowUpSteps } from './follow-up-steps';
import { listenToMix } from './mix-listening';
import { buildPlugin } from './plugin-building';
import type { AssistantSession } from './session';

/** Rounds of look-ups (query actions) one request may take before Studio has to answer. */
const MAX_LOOKUPS = 3;

/** What a turn knows about the request it is answering. */
export interface TurnInfo {
  /** The performance the request came with, if any. */
  take: Take | null;
  /** The musician's words. */
  request: string;
  /** This answer already follows a mix analysis (so it must not ask for another). */
  analyzed: boolean;
  /** The part of the song the request is about, as it was when asked. */
  focus: AiFocus | null;
  /** Edits beyond the part: undefined asks the musician first (when there are any). */
  outside?: 'refuse' | 'allow';
  /** How many rounds of look-ups (query actions) led to this answer. */
  lookupRounds?: number;
  /** The answer was written by the offline generator, not an AI. */
  offline?: boolean;
}

type AppliedAnswer = ReturnType<typeof applyAnswer>;

/**
 * Applies the answer, or (working on a part, when the answer also reaches outside it) puts it in the chat
 * to wait for the musician's OK. Returns null when nothing was applied; the request is over then.
 */
function applyOrAskApproval(
  session: AssistantSession,
  answer: AiAnswer,
  turn: TurnInfo,
  part: ResolvedFocus | null,
): AppliedAnswer | null {
  const { services, store } = session;
  const context = {
    // Selected notes: a beat makes a new pattern instead of rewriting theirs.
    previousBeat: part?.notes ? null : store.getState().applied,
    ...(turn.request ? { label: turn.request } : {}),
    focus: part,
    ...(turn.outside ? { focusOutside: turn.outside } : {}),
  };
  try {
    if (part && !turn.outside) {
      const dryRun = applyAnswer(services, answer, { ...context, dryRun: true });
      if (dryRun.outsideFocus?.length) {
        const messageId = session.say('assistant', answer.message || 'Here is what I would change.', {
          approval: { part: part.label, outside: [...new Set(dryRun.outsideFocus)], state: 'ask' },
        });
        const { take, request, analyzed, focus } = turn;
        session.approvals.set(messageId, { answer, take, request, analyzed, focus });
        store.setState({ phase: 'idle' });
        return null;
      }
    }
    return applyAnswer(services, answer, context);
  } catch (error) {
    console.error('[agstudio] applying the Studio answer failed', error);
    session.say('assistant', `Something went wrong applying that: ${errorText(error)}`, { error: true });
    store.setState({ phase: 'idle' });
    return null;
  }
}

/** Selects what the answer made the focus of: its clips, and its notes when the editor is showing them. */
function selectWhatChanged(session: AssistantSession, result: AppliedAnswer): void {
  const { services } = session;
  if (result.selectClips?.length) services.editor.getState().selectClips(result.selectClips);
  const notes = result.focus?.kind === 'notes' ? result.focus : null;
  if (!notes) return;
  const isShowingThePattern = services.view.getState().currentPatternId === notes.patternId;
  const isSelectedChannel = services.session.getState().selectedChannelId === notes.channelId;
  if (isShowingThePattern && isSelectedChannel) services.editor.getState().selectNotes(notes.noteIds);
}

/**
 * Plays what an answer changed, when autoplay is on and nothing else decided: the part on a loop, the song
 * from a bar before the edit, or a new beat.
 */
function autoplayAfterEdit(
  session: AssistantSession,
  result: AppliedAnswer,
  part: ResolvedFocus | null,
  askedFocus: AiFocus | null,
): void {
  const { services } = session;
  if (part && result.edited) {
    playFocus(services, result.focus ?? askedFocus);
  } else if (result.touched) {
    const oneBarTicks = ticksPerBar(services.doc.getState().project.transport.timeSig);
    services.view.getState().setMode('song');
    services.engine.play(Math.max(0, result.touched.from - oneBarTicks));
  } else if (result.beat) {
    services.view.getState().setMode('pattern');
    services.engine.play();
  }
}

/** Lets the musician hear the sound the answer made (not over the playing song). */
function startAudition(session: AssistantSession, after: readonly AfterEdit[]): void {
  const requested = after.find((action) => action.kind === 'audition');
  if (requested?.kind !== 'audition' || session.services.engine.playing) return;
  session.stopAudition?.();
  session.stopAudition = audition(session.services, requested.channelId, requested.phrase);
}

/**
 * Runs the answer's commands and deck actions and says what happened in the chat (with an Undo when the
 * project changed). The UI is told which windows to open and which file dialogs wait for a click.
 */
function reportAnswer(
  session: AssistantSession,
  answer: AiAnswer,
  result: AppliedAnswer,
  cursor: number,
  offline: boolean,
): void {
  const { services, store } = session;
  const report = { changes: [...result.changes, ...(result.ui ?? [])], warnings: result.warnings };
  // Live DJ deck actions run now (loading a song takes a moment: problems come up as messages).
  startDeckActions(services, result.after, report.changes);
  // App commands: most run now; file dialogs wait for the musician's click (the UI asks).
  runCommands(services, result.after, report, { waitingNote: (title) => `${title}: waiting for your click` });
  session.say('assistant', answer.message || (report.changes.length ? 'Done.' : 'Nothing to change.'), {
    ...(report.changes.length ? { changes: report.changes } : {}),
    ...(report.warnings.length ? { warnings: report.warnings } : {}),
    ...(result.edited ? { undo: cursor } : {}),
    ...(offline ? { offline: true } : {}),
    ...beatMessageFields(services, result.beat, cursor),
  });
  store.setState({
    phase: 'idle',
    ...(result.beat ? { applied: result.beat } : {}),
    uiRequests: result.after.filter(
      (action) => action.kind === 'open' || (action.kind === 'command' && action.gesture),
    ),
  });
}

/**
 * Everything that happens after an answer is in the project: its follow-up steps (leveling the mix…, in the
 * answer's undo step), the playback it asked for, new plugins to build, a sound to audition and, with
 * autoplay on, playing what changed.
 */
async function playAfterAnswer(
  session: AssistantSession,
  result: AppliedAnswer,
  where: { cursor: number; part: ResolvedFocus | null; askedFocus: AiFocus | null },
): Promise<void> {
  const { services, store } = session;
  const listened = await runFollowUpSteps(session, result.after, result.edited ? where.cursor : null);
  if (result.edited) await waitForNewSounds(services);
  // Playback the answer asked for (or, with autoplay on, what it arranged or a new beat).
  applyRequestedPlayback(services, result.after, { canArmRecording: true });
  for (const action of result.after) if (action.kind === 'build_plugin') void buildPlugin(session, action.spec);
  startAudition(session, result.after);
  // The musician pressed Play themselves while it finished: leave their playback alone.
  const playbackDecided = listened || result.after.some((action) => action.kind === 'play' || action.kind === 'stop');
  if (!playbackDecided && store.getState().autoplay) autoplayAfterEdit(session, result, where.part, where.askedFocus);
}

/**
 * Applies the AI's answer as one undo step and reports it in the chat. True when the answer asked to hear
 * the mix first (and this turn wasn't already the answer to an analysis).
 */
export async function applyTurn(session: AssistantSession, answer: AiAnswer, turn: TurnInfo): Promise<boolean> {
  const { services, store } = session;
  // The part as it is now (it may have moved while the AI was thinking).
  const part = resolveFocus(services.doc.getState().project, turn.focus);
  const result = applyOrAskApproval(session, answer, turn, part);
  if (!result) return false;

  const wantsToListen = result.after.some((action) => action.kind === 'analyze_mix');
  session.lastProblems = result.warnings;
  const cursor = services.history.status().cursor;
  reportAnswer(session, answer, result, cursor, turn.offline === true);
  // The part after the edit (copies made for it, clips that moved), unless the musician changed it meanwhile.
  if (part && result.focus && store.getState().focus === turn.focus) session.setFocus(result.focus);
  selectWhatChanged(session, result);
  await playAfterAnswer(session, result, { cursor, part, askedFocus: turn.focus });

  // It asked to look at something (query actions): ask again with what the read tools returned.
  if (result.queries?.length) {
    const lookupRounds = turn.lookupRounds ?? 0;
    if (lookupRounds >= MAX_LOOKUPS) {
      session.say(
        'assistant',
        'I looked at what I could, but I still need more than I can read in one go. Ask me about one part at a time.',
        {},
      );
      return false;
    }
    await lookUpAndAsk(session, result.queries, { ...turn, lookupRounds: lookupRounds + 1 });
    return false;
  }
  return wantsToListen && !turn.analyzed;
}

/** Asks the AI again with what its look-ups found (read just now), and applies the answer. */
async function lookUpAndAsk(
  session: AssistantSession,
  queries: NonNullable<AppliedAnswer['queries']>,
  turn: TurnInfo,
): Promise<void> {
  const { services, store } = session;
  store.setState({ phase: 'thinking' });
  const route = await session.route();
  if (!route) {
    store.setState({ phase: 'idle' });
    return;
  }
  const ownsAbort = session.abort === null;
  const abort = session.abort ?? new AbortController();
  session.abort = abort;
  try {
    const text = buildTurnText(session, {
      prompt: turn.request,
      route,
      take: null,
      focus: resolveFocus(services.doc.getState().project, turn.focus),
      lookups: formatLookups(queries),
    });
    const answer = await askStudio(session, { text, route, signal: abort.signal });
    const answerTurn: TurnInfo = {
      take: null,
      request: turn.request,
      analyzed: turn.analyzed,
      focus: turn.focus,
      lookupRounds: turn.lookupRounds,
    };
    const wantsToListen = await applyTurn(session, answer, answerTurn);
    if (wantsToListen) await listenAndAsk(session, turn.request, { fromUser: false, focus: turn.focus });
  } catch (error) {
    const stopped = isAbortError(error);
    session.say('assistant', stopped ? 'Stopped.' : errorText(error), { ...(stopped ? {} : { error: true }) });
    store.setState({ phase: 'idle' });
  } finally {
    if (ownsAbort) session.abort = null;
  }
}

/**
 * Renders and measures the mix (every mixer track too), shows what it found, and asks the AI again with the
 * analysis so it can mix with real numbers. `fromUser`: the musician asked for a mix check (their message goes
 * in the chat first). Without an AI it still shows the findings. `focus`: the part to listen to (and change);
 * without it the conversation's part.
 */
export async function listenAndAsk(
  session: AssistantSession,
  request: string,
  options: { fromUser: boolean; focus?: AiFocus | null },
): Promise<void> {
  const { services, store } = session;
  const state = store.getState();
  if (options.fromUser && state.phase !== 'idle') return;
  const asked = options.focus === undefined ? state.focus : options.focus;
  const part = resolveFocus(services.doc.getState().project, asked);
  const snapshot = part ? asked : null;
  if (options.fromUser) {
    const about = session.aboutText(asked, part);
    session.say('you', request, about ? { detail: about } : {});
  }
  const abort = new AbortController();
  session.abort = abort;
  const analysis = await listenToMix(session, part, abort.signal);
  if (analysis === null) return;

  store.setState({ phase: 'thinking', listening: null });
  const route = await session.route();
  if (!route) {
    session.say(
      'assistant',
      'Connect an AI (the ⋯ menu in Studio: your Claude subscription or ChatGPT) and I can make these changes for you; the findings above are a start.',
      { offline: true },
    );
    store.setState({ phase: 'idle' });
    session.abort = null;
    return;
  }
  try {
    const text = buildTurnText(session, {
      prompt: request,
      route,
      take: null,
      analysis,
      focus: resolveFocus(services.doc.getState().project, snapshot),
    });
    const answer = await askStudio(session, { text, route, signal: abort.signal });
    await applyTurn(session, answer, { take: null, request, analyzed: true, focus: snapshot });
  } catch (error) {
    const stopped = isAbortError(error);
    session.say('assistant', stopped ? 'Stopped.' : errorText(error), { ...(stopped ? {} : { error: true }) });
    store.setState({ phase: 'idle' });
  } finally {
    session.abort = null;
  }
}

/** Answers still waiting for an OK are about the song as it was: a new request retires them. */
export function retireApprovals(session: AssistantSession): void {
  if (session.approvals.size === 0) return;
  const retired = new Set(session.approvals.keys());
  session.approvals.clear();
  session.store.setState((state) => ({
    messages: state.messages.map((message) =>
      retired.has(message.id) && message.approval
        ? { ...message, approval: { ...message.approval, state: 'expired' as const } }
        : message,
    ),
  }));
}

/**
 * The musician's choice on an answer that reaches outside the part: 'all' applies everything (the part still
 * gets its own copies of shared patterns), 'part' only what stays inside it. One undo step.
 */
export async function approve(session: AssistantSession, messageId: number, choice: 'all' | 'part'): Promise<void> {
  const { services, store } = session;
  const pending = session.approvals.get(messageId);
  const markApproval = (state: ApprovalMessage['state']) =>
    store.setState((current) => ({
      messages: current.messages.map((message) =>
        message.id === messageId && message.approval
          ? { ...message, approval: { ...message.approval, state } }
          : message,
      ),
    }));
  // Another project is open now: the answer was about the old one.
  const isOtherProject = pending?.focus && pending.focus.projectId !== services.doc.getState().project.projectId;
  if (!pending || isOtherProject) {
    session.approvals.delete(messageId);
    markApproval('expired');
    return;
  }
  if (store.getState().phase !== 'idle') return;
  session.approvals.delete(messageId);
  markApproval(choice);
  const { answer, take, request, analyzed, focus } = pending;
  const outside = choice === 'all' ? 'allow' : 'refuse';
  const wantsToListen = await applyTurn(session, answer, { take, request, analyzed, focus, outside });
  if (wantsToListen) await listenAndAsk(session, request, { fromUser: false, focus });
}
