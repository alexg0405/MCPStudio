import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { AiServerError, Sessions, type Backend, type BeatReply, type BeatRequest } from './types.ts';

/**
 * Claude through the API with ANTHROPIC_API_KEY (from .env.local). Structured output gives the beat
 * as JSON; the conversation is append-only (thinking blocks included) so follow-ups stay valid.
 */

type History = Anthropic.Beta.Messages.BetaMessageParam[];

/** Server-side refusal fallback exists for these models (not for Haiku). */
const FALLBACK = /^claude-(opus-5-5|sonnet-5-5|opus-5|fable-5-1)\b/;

export function apiBackend(getKey: () => string | undefined): Backend {
  const sessions = new Sessions<History>();
  return {
    async status() {
      return getKey()
        ? { ok: true }
        : { ok: false, reason: 'Add ANTHROPIC_API_KEY=… to .env.local in the project folder (see .env.example).' };
    },

    async beat(req: BeatRequest, signal: AbortSignal): Promise<BeatReply> {
      const apiKey = getKey();
      if (!apiKey)
        throw new AiServerError('No Claude API key: add ANTHROPIC_API_KEY=… to .env.local.', 'not_configured', 503);
      const client = new Anthropic({ apiKey });
      const id = sessions.get(req.session) ? (req.session as string) : randomUUID();
      const messages: History = [...(sessions.get(id) ?? []), { role: 'user', content: req.text }];
      let message: Anthropic.Beta.Messages.BetaMessage;
      try {
        const stream = client.beta.messages.stream(
          {
            model: req.model,
            max_tokens: 32000,
            system: req.system,
            messages,
            // Medium effort keeps a beat to a few seconds of thinking; it's an interactive request.
            output_config: { effort: 'medium', format: { type: 'json_schema', schema: req.schema } },
            ...(FALLBACK.test(req.model)
              ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
              : {}),
          },
          { signal },
        );
        message = await stream.finalMessage();
      } catch (e) {
        if (e instanceof Anthropic.APIUserAbortError) throw e;
        if (e instanceof Anthropic.AuthenticationError)
          throw new AiServerError('Claude rejected the API key in .env.local.', 'authentication_error', 401);
        if (e instanceof Anthropic.PermissionDeniedError)
          throw new AiServerError("This API key can't use that model.", 'permission_error', 403);
        if (e instanceof Anthropic.RateLimitError)
          throw new AiServerError('Claude is rate-limiting requests; try again in a moment.', 'rate_limit_error', 429);
        if (e instanceof Anthropic.APIConnectionError)
          throw new AiServerError("Couldn't reach Claude. Check your internet connection.", 'connection_error', 502);
        if (e instanceof Anthropic.APIError) {
          const overloaded = e.status === 529;
          throw new AiServerError(
            overloaded ? 'Claude is overloaded right now; try again shortly.' : e.message,
            overloaded ? 'overloaded_error' : 'api_error',
            e.status ?? 502,
          );
        }
        throw e;
      }
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
      sessions.set(id, [...messages, { role: 'assistant', content: message.content }]);
      return { session: id, beat, model: message.model };
    },
  };
}
