/**
 * The no-AI path for changing a song that already exists: the offline edit interpreter (`core/offline-edit`) turns plain words
 * into the same actions an AI's answer carries, and they go through `applyTurn` like any answer: one undo step, held to the part
 * the musician picked (the focus guard), the arranger's follow-up work, the leveling step and autoplay.
 */
import type { Project } from '@core/model/types';
import { interpretEdit } from '@core/offline-edit/interpret';
import type { BarRange, EditInput } from '@core/offline-edit/types';
import { songLength } from '@core/query/playlist';
import { ticksPerBar } from '@core/time/ppq';
import { focusFromRange } from '../../ai/focus-capture';
import type { AiFocus, ResolvedFocus } from '../../ai/focus';
import { rolesOf } from '../../arrange/env';
import type { AssistantSession } from './session';
import { applyTurn } from './turn';

/** What the request was: answered here (a change or a reply), or not an edit of the song at all. */
export type OfflineEditOutcome = 'answered' | 'not-an-edit';

/** The part the musician picked as bars and a name, for the interpreter. */
function focusInput(project: Project, focus: ResolvedFocus | null): EditInput['focus'] {
  if (!focus || focus.notes) return null;
  const bar = ticksPerBar(project.transport.timeSig);
  const range: BarRange = { fromBar: Math.floor(focus.from / bar) + 1, toBar: Math.max(1, Math.ceil(focus.to / bar)) };
  return { range, label: focus.label };
}

/** The part the interpreter asks the answer to be held to, as a focus the guard understands. */
function focusForGuard(session: AssistantSession, guard: BarRange): AiFocus | null {
  const project = session.services.doc.getState().project;
  const bar = ticksPerBar(project.transport.timeSig);
  const to = Math.min(guard.toBar * bar, songLength(project));
  return focusFromRange(session.services, (guard.fromBar - 1) * bar, to);
}

/**
 * Reads the request as a change to the song and applies it. `askedFocus` is the part the musician picked (it holds the answer
 * to that part); without one, words that name a part ("in the chorus") hold it to that part too.
 */
export async function runOfflineEdit(
  session: AssistantSession,
  request: string,
  part: { focus: ResolvedFocus | null; asked: AiFocus | null },
): Promise<OfflineEditOutcome> {
  const { services, store } = session;
  const project = services.doc.getState().project;
  const outcome = interpretEdit({
    text: request,
    project,
    roles: rolesOf(project),
    focus: focusInput(project, part.focus),
    variation: session.offlineEdits,
  });
  if (outcome.kind === 'none') return 'not-an-edit';
  if (outcome.kind === 'reply') {
    session.say('assistant', outcome.text, { offline: true });
    store.setState({ phase: 'idle' });
    return 'answered';
  }
  session.offlineEdits++;
  const held = part.asked ?? (outcome.guard ? focusForGuard(session, outcome.guard) : null);
  await applyTurn(session, { message: outcome.message, actions: outcome.actions }, {
    take: null,
    request,
    analyzed: false,
    focus: held,
    offline: true,
  });
  return 'answered';
}
