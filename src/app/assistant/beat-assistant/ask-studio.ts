/**
 * One question to the AI in Studio's voice: the system prompt (the rules and the catalog index), the answer schema and the
 * model the musician picked, with the answer read and checked (`readAnswer`) before it is returned.
 */
import { catalogIndex } from '../../ai/catalog-index';
import { focusContext, type ResolvedFocus } from '../../ai/focus';
import { projectContext } from '../../ai/context';
import { studioSystem } from '../../ai/prompt';
import { ACTIONS_SCHEMA, readAnswer, type AiAnswer } from '../../ai/schema';
import { VOICE_SUMMARY_LEGEND } from '@core/voice';
import { performanceBlock, type AiBackend } from '../claude';
import type { Take } from '../state';
import { catalogBlocks } from './catalog-blocks';
import type { AssistantSession } from './session';

/** Said when the AI cannot call read tools this turn (the dev server's MCP is not there, or switched off in the settings). */
const NO_READ_TOOLS_NOTE =
  '<tools>You have no read tools in this conversation. To look something up, use a query action with the same tool and use its result in the next turn.</tools>';

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

/**
 * This turn's message to the AI: the request, the project, the part it is about, the details of the plugins and commands the
 * request most likely needs (and what changed in the catalog since this conversation began), and what else this backend's
 * conversation doesn't have yet. The catalog index itself is in the system prompt.
 */
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
  const catalog = catalogBlocks(session, { route, request: prompt, focus: focus ?? null });
  session.stagedCatalog = catalog;
  parts.push(...catalog.blocks);
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
  if (!session.canUseReadTools()) parts.push(NO_READ_TOOLS_NOTE);
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

/** Asks the AI for the next answer and returns it (throws when the request fails or is stopped). */
export async function askStudio(
  session: AssistantSession,
  question: { text: string; route: AiBackend; signal: AbortSignal },
): Promise<AiAnswer> {
  const system = studioSystem(catalogIndex(session.services));
  const staged = session.stagedCatalog;
  session.stagedCatalog = null;
  const answer = await session.chat.ask<AiAnswer>({
    system: system.text,
    systemBlocks: system.blocks,
    schema: ACTIONS_SCHEMA,
    text: question.text,
    model: session.modelFor(question.route),
    backend: question.route,
    readTools: session.canUseReadTools(),
    signal: question.signal,
    read: (raw) => {
      const checked = readAnswer(raw);
      return 'error' in checked ? { error: checked.error } : { value: checked.answer };
    },
  });
  // The AI has the request now: what the turn told it about the catalog is known from here on.
  staged?.commit();
  return answer;
}
