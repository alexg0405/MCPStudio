import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { runTurn, systemBlocks, type History, type MessageStreamer, type TurnInput, type TurnOutput } from './api-loop.ts';
import { LookupUnavailableError, McpLookupClient, type LookupTool } from './mcp-client.ts';
import {
  AiServerError,
  Sessions,
  type Backend,
  type BeatReply,
  type BeatRequest,
  type LookupAccess,
} from './types.ts';

/**
 * Claude through the API with ANTHROPIC_API_KEY (from .env.local). Structured output gives the beat
 * as JSON; the conversation is append-only (thinking blocks and tool calls included) so follow-ups stay valid.
 * When the page can answer read-tool calls, Claude may look things up during the turn (api-loop.ts).
 */

/** A conversation: what was said, and the system prompt it began with (kept, so the cached prefix stays the same). */
interface ApiSession {
  messages: History;
  system: string;
  systemParts: string[] | undefined;
}

/** What the backend reaches outside itself with (the tests pass fakes). */
export interface ApiDeps {
  createClient?: (apiKey: string) => MessageStreamer;
  fetch?: typeof fetch;
}

/** Server-side refusal fallback exists for these models (not for Haiku). */
const FALLBACK = /^claude-(opus-5-5|sonnet-5-5|opus-5|fable-5-1)\b/;

const fallbackParams = (model: string) =>
  FALLBACK.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {};

/** Maps an SDK failure to an error for the musician. */
function explain(e: unknown): unknown {
  if (e instanceof Anthropic.APIUserAbortError) return e;
  if (e instanceof Anthropic.AuthenticationError)
    return new AiServerError('Claude rejected the API key in .env.local.', 'authentication_error', 401);
  if (e instanceof Anthropic.PermissionDeniedError)
    return new AiServerError("This API key can't use that model.", 'permission_error', 403);
  if (e instanceof Anthropic.RateLimitError)
    return new AiServerError('Claude is rate-limiting requests; try again in a moment.', 'rate_limit_error', 429);
  if (e instanceof Anthropic.APIConnectionError)
    return new AiServerError("Couldn't reach Claude. Check your internet connection.", 'connection_error', 502);
  if (e instanceof Anthropic.APIError) {
    const overloaded = e.status === 529;
    return new AiServerError(
      overloaded ? 'Claude is overloaded right now; try again shortly.' : e.message,
      overloaded ? 'overloaded_error' : 'api_error',
      e.status ?? 502,
    );
  }
  return e;
}

/** The read tools the endpoint offers, or none when it cannot be reached (the turn then goes on without them). */
async function openLookups(
  access: LookupAccess,
  signal: AbortSignal,
  fetchImpl: typeof fetch | undefined,
): Promise<TurnInput['lookups']> {
  const client = new McpLookupClient(access, fetchImpl);
  let tools: LookupTool[];
  try {
    tools = await client.listTools(signal);
  } catch (e) {
    if (signal.aborted || !(e instanceof LookupUnavailableError)) throw e;
    return undefined;
  }
  const allowed = new Set(access.tools);
  const readTools = tools.filter((tool) => allowed.has(tool.name));
  if (readTools.length === 0) return undefined;
  return { tools: readTools, call: (name, args, callSignal) => client.callTool(name, args, callSignal) };
}

export function apiBackend(getKey: () => string | undefined, deps: ApiDeps = {}): Backend {
  const sessions = new Sessions<ApiSession>();
  return {
    async status() {
      return getKey()
        ? { ok: true }
        : { ok: false, reason: 'Add ANTHROPIC_API_KEY=… to .env.local in the project folder (see .env.example).' };
    },

    async beat(req: BeatRequest, signal: AbortSignal, access?: LookupAccess): Promise<BeatReply> {
      const apiKey = getKey();
      if (!apiKey)
        throw new AiServerError('No Claude API key: add ANTHROPIC_API_KEY=… to .env.local.', 'not_configured', 503);
      const client = deps.createClient?.(apiKey) ?? new Anthropic({ apiKey });
      const known = sessions.get(req.session);
      const id = known ? (req.session as string) : randomUUID();
      // A conversation keeps the system prompt it began with: a changed one (a new plugin) would be a different prefix, and
      // the AI is told what changed in the turn's text instead.
      const system = known?.system ?? req.system;
      const systemParts = known ? known.systemParts : req.systemBlocks;
      const messages: History = [...(known?.messages ?? []), { role: 'user', content: req.text }];
      const lookups = req.readTools && access ? await openLookups(access, signal, deps.fetch) : undefined;
      let turn: TurnOutput;
      try {
        turn = await runTurn({
          client,
          model: req.model,
          system: systemBlocks(system, systemParts),
          schema: req.schema,
          messages,
          extra: fallbackParams(req.model),
          signal,
          ...(lookups ? { lookups } : {}),
        });
      } catch (e) {
        throw explain(e);
      }
      const { message } = turn;
      if (message.stop_reason === 'refusal') {
        const why = message.stop_details?.explanation;
        throw new AiServerError(`Claude declined this request${why ? `: ${why}` : '.'}`, 'refusal', 422);
      }
      if (message.stop_reason === 'max_tokens')
        throw new AiServerError('The answer came back cut off. Ask for a little less at once.', 'max_tokens', 502);
      const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      let beat: unknown;
      try {
        beat = JSON.parse(text);
      } catch {
        throw new AiServerError("Claude's answer wasn't valid JSON.", 'bad_output', 502);
      }
      sessions.set(id, { messages: turn.messages, system, systemParts });
      return { session: id, beat, model: message.model };
    },
  };
}
