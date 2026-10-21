import type Anthropic from '@anthropic-ai/sdk';
import type { LookupResult, LookupTool } from './mcp-client.ts';

/**
 * One turn of the API backend: the request to Claude, and (when the AI may look things up) the loop of tool calls until it
 * answers. The tools are AGstudio's read tools, called through the MCP bridge from this server (mcp-client.ts); the answer is
 * the structured output of the last reply.
 *
 * Prompt caching: the request is `tools`, then `system`, then the conversation, and the cache reuses any prefix of it that
 * is byte-identical. The system blocks (the rules, the catalog index) get a breakpoint each, with the one-hour lifetime
 * because the same prompt starts every chat; the conversation gets one on its last block, so the next turn pays only for
 * what is new. That is three of the four breakpoints a request may have.
 */

// The beta types by their short names.
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaMessageStreamParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type BetaTextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;
type BetaTool = Anthropic.Beta.Messages.BetaTool;
type BetaToolInputSchema = Anthropic.Beta.Messages.BetaTool.InputSchema;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export type History = BetaMessageParam[];

/** The part of the SDK client this uses (the tests pass a fake one). */
export interface MessageStreamer {
  beta: {
    messages: {
      stream(
        body: BetaMessageStreamParams,
        options?: { signal?: AbortSignal },
      ): { finalMessage(): Promise<BetaMessage> };
    };
  };
}

/** Most rounds of tool calls one turn may take before it has to answer (the last request forbids tools). */
export const MAX_LOOKUP_ROUNDS = 6;
/** The most characters of one tool result sent back (a read that long is cut with a note, as the chat's look-ups are). */
export const MAX_RESULT_CHARS = 30_000;

const SYSTEM_CACHE = { type: 'ephemeral', ttl: '1h' } as const;
const CONVERSATION_CACHE = { type: 'ephemeral' } as const;

/** The system prompt as blocks with a cache breakpoint after each, or as one block when the parts do not add up to it. */
export function systemBlocks(system: string, parts: readonly string[] | undefined): BetaTextBlockParam[] {
  const texts = parts && parts.length > 0 && parts.join('\n\n') === system ? parts : [system];
  return texts.map((text) => ({ type: 'text', text, cache_control: SYSTEM_CACHE }));
}

/**
 * The history with a cache breakpoint on its last block. A copy: a breakpoint stays in the stored history, the next turn would
 * carry it and the old ones, past the four a request may have.
 */
export function withConversationBreakpoint(messages: History): History {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const blocks: BetaContentBlockParam[] =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
  const tail = blocks[blocks.length - 1];
  // The turn's message is the musician's text, or the results of the tool calls: those take a breakpoint.
  if (tail?.type !== 'text' && tail?.type !== 'tool_result') return messages;
  blocks[blocks.length - 1] = { ...tail, cache_control: CONVERSATION_CACHE };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

/** The tools as the API takes them, in the order the endpoint listed them (it must not vary: tools come first in the cache). */
export function apiTools(tools: readonly LookupTool[]): BetaTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as BetaToolInputSchema,
  }));
}

/** What a turn needs to ask Claude. */
export interface TurnInput {
  client: MessageStreamer;
  model: string;
  system: BetaTextBlockParam[];
  schema: Record<string, unknown>;
  /** The conversation so far, ending with this turn's message. */
  messages: History;
  /** Extra request parameters (the refusal fallback). */
  extra: Partial<BetaMessageStreamParams>;
  signal: AbortSignal;
  /** The read tools and how to call one; none when the AI cannot look things up this turn. */
  lookups?: { tools: readonly LookupTool[]; call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<LookupResult> };
}

/** What a turn produced: Claude's last reply and the whole conversation, tool calls and their results included. */
export interface TurnOutput {
  message: BetaMessage;
  messages: History;
}

/** One request to Claude. A `tool_choice` of none ends the look-ups (the model has to answer). */
async function ask(input: TurnInput, messages: History, options: { mayCallTools: boolean }): Promise<BetaMessage> {
  const tools = input.lookups ? apiTools(input.lookups.tools) : [];
  const stream = input.client.beta.messages.stream(
    {
      model: input.model,
      max_tokens: 32000,
      system: input.system,
      messages: withConversationBreakpoint(messages),
      // Medium effort keeps a beat to a few seconds of thinking; it's an interactive request.
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: input.schema } },
      ...(tools.length > 0 ? { tools, ...(options.mayCallTools ? {} : { tool_choice: { type: 'none' as const } }) } : {}),
      ...input.extra,
    },
    { signal: input.signal },
  );
  return stream.finalMessage();
}

/** Cuts a tool result that is too long, saying so. */
const capped = (text: string): string =>
  text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}…(cut: ask again for less, e.g. fewer ids or one channel)`
    : text;

/** Runs every tool call of a reply and returns the results (one message, as the API wants): a failure is a result the model reads. */
async function answerToolCalls(
  message: BetaMessage,
  lookups: NonNullable<TurnInput['lookups']>,
  signal: AbortSignal,
): Promise<BetaToolResultBlockParam[]> {
  const known = new Set(lookups.tools.map((tool) => tool.name));
  const results: BetaToolResultBlockParam[] = [];
  for (const block of message.content) {
    if (block.type !== 'tool_use') continue;
    if (!known.has(block.name)) {
      results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: `There is no tool "${block.name}".` });
      continue;
    }
    try {
      const result = await lookups.call(block.name, (block.input ?? {}) as Record<string, unknown>, signal);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: capped(result.text),
        ...(result.isError ? { is_error: true } : {}),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const why = error instanceof Error ? error.message : String(error);
      results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: why });
    }
  }
  return results;
}

/** Asks Claude, and while it calls read tools answers them, until it gives its answer. */
export async function runTurn(input: TurnInput): Promise<TurnOutput> {
  const messages = [...input.messages];
  for (let round = 0; ; round++) {
    const message = await ask(input, messages, { mayCallTools: round < MAX_LOOKUP_ROUNDS });
    messages.push({ role: 'assistant', content: message.content });
    if (message.stop_reason !== 'tool_use' || !input.lookups) return { message, messages };
    messages.push({ role: 'user', content: await answerToolCalls(message, input.lookups, input.signal) });
  }
}
