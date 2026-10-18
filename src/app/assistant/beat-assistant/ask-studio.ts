/**
 * One question to the AI in Studio's voice: the system prompt, the answer schema and the model the musician
 * picked, with the answer read and checked (`readAnswer`) before it is returned.
 */
import { pluginCatalog } from '../../ai/catalog';
import { commandCatalog } from '../../ai/commands';
import { focusContext, type ResolvedFocus } from '../../ai/focus';
import { projectContext } from '../../ai/context';
import { STUDIO_PROMPT } from '../../ai/prompt';
import { ACTIONS_SCHEMA, readAnswer, type AiAnswer } from '../../ai/schema';
import { VOICE_SUMMARY_LEGEND } from '@core/voice';
import { performanceBlock, type AiBackend } from '../claude';
import type { Take } from '../state';
import type { AssistantSession } from './session';

/** What one turn's message to the AI is built from. */
export interface TurnTextInput {
  /** The musician's request. */
  prompt: string;
  /** The way it reaches the AI (each backend has its own conversation). */
  route: AiBackend;
  /** The performance to send along, unless the AI has it already. */
  take: Take | null;
  /** The measured mix, when this turn answers a mix check. */
  analysis?: string;
  /** The part of the song the request is about. */
  focus?: ResolvedFocus | null;
  /** What the AI asked to look at (read just now), when this turn answers its look-ups. */
  lookups?: string;
}

/** This turn's message to the AI: the request, the project, the part it is about, and what this backend's conversation doesn't have yet. */
export function buildTurnText(session: AssistantSession, input: TurnTextInput): string {
  const { services } = session;
  const { prompt, route, take, analysis, focus, lookups } = input;
  const parts = [
    `<request>\n${prompt.trim()}\n</request>`,
    `<project>\n${projectContext(services, focus ?? null)}\n</project>`,
  ];
  if (focus) {
    const focusText = focusContext(services.doc.getState().project, focus, session.pluginInfo);
    parts.push(`<focus>\n${focusText}\n</focus>`);
  }
  if (lookups) {
    parts.push(
      `<lookups>\n${lookups}\n</lookups>\nThis is what you asked to look at (read just now). Answer the request with it; look up again only if something is still missing.`,
    );
  }
  if (analysis) {
    parts.push(
      `<mix-analysis>\n${analysis}\n</mix-analysis>\nThis is how the mix sounds right now (rendered and measured just now). Answer the request with it; don't ask for another analysis.`,
    );
  }
  parts.push(...catalogBlocksNotSentYet(session, route));
  if (take && !take.sent) {
    parts.push(
      performanceBlock({
        summary: `${VOICE_SUMMARY_LEGEND}\n${take.summary}`,
        role: take.role,
        bars: take.bars,
        bpm: take.bpm,
      }),
    );
  }
  if (session.lastProblems.length) {
    parts.push(
      `<last-turn-problems>\nThese actions of your last answer couldn't be applied:\n- ${session.lastProblems.join('\n- ')}\n</last-turn-problems>`,
    );
  }
  return parts.join('\n\n');
}

/**
 * The plugin and command lists, when this backend's conversation doesn't have the current ones (a new
 * conversation, or plugins changed since): they are long, so they are not repeated every turn.
 */
function catalogBlocksNotSentYet(session: AssistantSession, route: AiBackend): string[] {
  const { services } = session;
  const catalog = pluginCatalog(services.plugins, services.presets);
  const commands = commandCatalog(services);
  const key = `${catalog.key}:${commands.key}`;
  if (session.chat.hasHistoryFor(route) && session.catalogSent[route] === key) return [];
  session.catalogSent[route] = key;
  return [`<plugins>\n${catalog.text}\n</plugins>`, `<commands>\n${commands.text}\n</commands>`];
}

/** Asks the AI for the next answer and returns it (throws when the request fails or is stopped). */
export function askStudio(
  session: AssistantSession,
  question: { text: string; route: AiBackend; signal: AbortSignal },
): Promise<AiAnswer> {
  return session.chat.ask<AiAnswer>({
    system: STUDIO_PROMPT,
    schema: ACTIONS_SCHEMA,
    text: question.text,
    model: session.modelFor(question.route),
    backend: question.route,
    signal: question.signal,
    read: (raw) => {
      const checked = readAnswer(raw);
      return 'error' in checked ? { error: checked.error } : { value: checked.answer };
    },
  });
}
