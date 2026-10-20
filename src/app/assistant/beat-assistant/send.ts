/**
 * Sending a request: which part of the song it is about, which backend answers it (an AI, or the offline
 * generator when none is set up), and what to do when the AI turns out to be unreachable.
 */
import { resolveFocus, type AiFocus, type ResolvedFocus } from '../../ai/focus';
import { AiError, type AiBackend } from '../claude';
import type { Take } from '../state';
import { askStudio, buildTurnText } from './ask-studio';
import { errorText, isAbortError } from './errors';
import { isSongRequest } from '@core/song/request';
import { writeOfflineBeat } from './offline-beat';
import { writeOfflineSong } from './offline-song';
import { inferRole, roleLabel } from './performance-role';
import type { AssistantSession } from './session';
import { reanalyzeTake } from './take-recorder';
import { applyTurn, listenAndAsk, retireApprovals } from './turn';

/** What the offline generator is told when the request is only a take ("turn my take into a beat"). */
const REQUEST_FROM_TAKE_ONLY = 'Make a beat from my performance.';
/** What the chat shows for a request that was only a take. */
const TAKE_ONLY_CHAT_TEXT = 'Turn my take into a beat.';

const NO_AI_FOR_A_PART =
  'Changing one part of the song needs an AI (your Claude subscription, ChatGPT through Codex, or an API key), and none is set up. Set one up in Studio’s ⋯ menu, or clear the part to make a beat with the offline generator.';

/** "808s that go like this" after a take left on "figure it out": listens to the take again as that instrument. */
function relistenForRequestedRole(session: AssistantSession, take: Take | null, request: string): Take | null {
  if (!take || take.role !== 'auto') return take;
  const role = inferRole(request);
  if (!role) return take;
  const relistened = reanalyzeTake(take, role) ?? take;
  session.store.setState({ take: relistened });
  return relistened;
}

/** The small print under the musician's message: what take it came with, and which part it is about. */
function requestDetail(
  session: AssistantSession,
  take: Take | null,
  asked: AiFocus | null,
  focus: ResolvedFocus | null,
): string {
  const takeNote = take ? takeDescription(take) : undefined;
  return [takeNote, session.aboutText(asked, focus)].filter(Boolean).join(' · ');
}

/** "with your 2-bar take (5 sounds, as an 808 line)". */
function takeDescription(take: Take): string {
  const soundCount = `${take.events.length} sound${take.events.length === 1 ? '' : 's'}`;
  const role = take.role === 'auto' ? '' : `, as ${roleLabel(take.role)}`;
  return `with your ${take.bars}-bar take (${soundCount}${role})`;
}

/** The result of asking an AI: the request is over, or the AI turned out not to be set up. */
type AskOutcome = 'finished' | 'not-set-up';

/** Asks the AI and applies its answer (and any look-up or mix listening it asks for next). */
async function askAi(
  session: AssistantSession,
  input: {
    request: string;
    route: AiBackend;
    take: Take | null;
    focus: ResolvedFocus | null;
    /** The part as the musician asked (kept as sent for the answer). */
    askedFocus: AiFocus | null;
    signal: AbortSignal;
  },
): Promise<AskOutcome> {
  const { store } = session;
  const { request, route, take, focus, askedFocus, signal } = input;
  try {
    const text = buildTurnText(session, {
      prompt: request || REQUEST_FROM_TAKE_ONLY,
      route,
      take,
      focus,
    });
    const answer = await askStudio(session, { text, route, signal });
    if (take) store.setState({ take: { ...take, sent: true } });
    const turn = { take, request, analyzed: false, focus: askedFocus };
    if (await applyTurn(session, answer, turn))
      await listenAndAsk(session, request, { fromUser: false, focus: askedFocus });
    return 'finished';
  } catch (error) {
    if (isAbortError(error)) {
      session.say('assistant', 'Stopped.', {});
      store.setState({ phase: 'idle' });
      return 'finished';
    }
    if (error instanceof AiError && error.kind === 'not-configured' && store.getState().backend === 'auto') {
      // Its setup changed since the last check: write this one offline, and look again.
      void session.checkAi();
      return 'not-set-up';
    }
    session.say('assistant', errorText(error), { error: true });
    store.setState({ phase: 'idle' });
    return 'finished';
  } finally {
    session.abort = null;
  }
}

/**
 * Asks for a beat or any change. `focus`: the part of the song the request is about (it becomes the
 * conversation's part; null clears it); without it the conversation's part, if any, stays.
 */
export async function send(
  session: AssistantSession,
  prompt: string,
  options: { focus?: AiFocus | null } = {},
): Promise<void> {
  const { services, store } = session;
  if (store.getState().phase !== 'idle') return;
  const request = prompt.trim();
  let take = store.getState().take;
  if (!request && !take) return;
  if (options.focus !== undefined) session.setFocus(options.focus);
  retireApprovals(session);
  // The part as it is now; a part that no longer exists is dropped. Kept as sent for the answer.
  const askedFocus = store.getState().focus;
  const focus = resolveFocus(services.doc.getState().project, askedFocus);
  if (askedFocus && !focus) session.setFocus(null);
  take = relistenForRequestedRole(session, take, request);

  const detail = requestDetail(session, take, askedFocus, focus);
  session.say('you', request || TAKE_ONLY_CHAT_TEXT, detail ? { detail } : {});
  store.setState({ phase: 'thinking' });
  const projectBpm = services.doc.getState().project.transport.bpm;

  // Stop works from the start, also while it checks how to reach the AI.
  const abort = new AbortController();
  session.abort = abort;
  const route = await session.route();
  if (abort.signal.aborted) {
    session.abort = null;
    session.say('assistant', 'Stopped.', {});
    store.setState({ phase: 'idle' });
    return;
  }
  if (route) {
    const outcome = await askAi(session, {
      request,
      route,
      take,
      focus,
      askedFocus: focus ? askedFocus : null,
      signal: abort.signal,
    });
    if (outcome === 'finished') return;
  } else {
    session.abort = null;
  }
  if (focus) {
    // The offline generator writes whole beats: it can't change one part of a song.
    session.say('assistant', NO_AI_FOR_A_PART, { offline: true });
    store.setState({ phase: 'idle' });
    return;
  }
  // Asking for a song (not a loop) and no performance to follow: the song generator writes the whole thing.
  if (!take && isSongRequest(request)) await writeOfflineSong(session, request);
  else await writeOfflineBeat(session, request, take, projectBpm);
}
