/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiBackend } from '../../tools/ai/api-backend.ts';
import { MAX_LOOKUP_ROUNDS, systemBlocks, withConversationBreakpoint, type History, type MessageStreamer } from '../../tools/ai/api-loop.ts';
import { AiServerError, type BeatRequest, type LookupAccess } from '../../tools/ai/types.ts';

/**
 * The API backend's turn (tools/ai/api-backend.ts and api-loop.ts) with a fake SDK client and a fake MCP endpoint, so no
 * real model is ever called: the prompt-cache breakpoints, the tool loop that calls the read tools through the MCP bridge (on
 * the server, with the access token read from its file), the conversation kept append-only, and the fallbacks.
 */
const SECRET = 'agmcp_API_TOKEN_THAT_ONLY_THE_ENDPOINT_MAY_SEE_0123456789';

let dir = '';
let tokenFile = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ag-api-lookups-'));
  tokenFile = join(dir, 'mcp-token');
  await writeFile(tokenFile, `${SECRET}\n`);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const TOOLS = ['get_plugin_details', 'search_catalog', 'get_mixer'];
const access = (): LookupAccess => ({
  url: 'http://localhost:5401/mcp?scope=lookup',
  tokenFile,
  command: 'node',
  args: ['helper.mjs'],
  tools: TOOLS,
});

const req = (over: Partial<BeatRequest> = {}): BeatRequest => ({
  backend: 'api',
  model: 'claude-opus-5-5',
  session: null,
  system: 'rules\n\nindex v1',
  systemBlocks: ['rules', 'index v1'],
  schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string' } } },
  text: '<request>add reverb</request>',
  ...over,
});

type Reply = { stop_reason: string; content: unknown[]; model?: string };
const text = (value: string): Reply => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: value }] });
const answer = text(JSON.stringify({ message: 'Done.' }));
const toolUse = (id: string, name: string, input: object): Reply => ({
  stop_reason: 'tool_use',
  content: [{ type: 'thinking', thinking: 'let me look', signature: 'sig' }, { type: 'tool_use', id, name, input }],
});

type Params = {
  system: { text: string; cache_control?: unknown }[];
  messages: { role: string; content: string | { type: string; cache_control?: unknown; [key: string]: unknown }[] }[];
  tools?: { name: string }[];
  tool_choice?: unknown;
  model: string;
};

/** A fake SDK client: it answers with the scripted replies, in order, and keeps a copy of every request. */
function fakeClient(replies: Reply[]) {
  const sent: Params[] = [];
  const client: MessageStreamer = {
    beta: {
      messages: {
        stream: (body) => {
          sent.push(structuredClone(body) as unknown as Params);
          const reply = replies.shift() ?? answer;
          return { finalMessage: async () => ({ model: 'claude-opus-5-5', ...reply }) as never };
        },
      },
    },
  };
  return { client, sent };
}

/** A fake MCP endpoint: `fetch` answers tools/list and tools/call, and keeps every request with its headers. */
function fakeEndpoint(options: { down?: boolean; results?: Record<string, { text: string; isError?: boolean }> } = {}) {
  const seen: { url: string; authorization: string | null; body: { method: string; params?: { name: string; arguments: unknown } } }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (options.down) throw new TypeError('connect ECONNREFUSED');
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as (typeof seen)[number]['body'] & { id: number };
    seen.push({ url, authorization: headers.get('authorization'), body });
    if (body.method === 'tools/list') {
      const tools = [...TOOLS, 'apply_actions'].map((name) => ({
        name,
        title: name,
        description: `Reads ${name}.`,
        inputSchema: { type: 'object', properties: {} },
      }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools } }), { status: 200 });
    }
    const result = options.results?.[body.params!.name] ?? { text: `{"ok":"${body.params!.name}"}` };
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const run = (replies: Reply[], request: BeatRequest, endpoint = fakeEndpoint(), lookup: LookupAccess | null = access()) => {
  const { client, sent } = fakeClient(replies);
  const backend = apiBackend(() => 'sk-test', { createClient: () => client, fetch: endpoint.fetchImpl });
  const done = backend.beat(request, new AbortController().signal, lookup ?? undefined);
  return { done, sent, endpoint, backend };
};

const countBreakpoints = (params: Params) =>
  params.system.filter((block) => block.cache_control).length +
  params.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content)).filter((b) => b.cache_control).length;

describe('prompt-cache breakpoints', () => {
  it('puts one after each system block (one hour: the same prompt starts every chat) and one on the end of the conversation', async () => {
    const { done, sent } = run([answer], req());
    await done;
    const [first] = sent;
    expect(first!.system).toEqual([
      { type: 'text', text: 'rules', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: 'index v1', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    const content = first!.messages.at(-1)!.content as { cache_control?: unknown }[];
    expect(content.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    expect(countBreakpoints(first!)).toBe(3);
  });

  it('is one system block when the parts do not add up to the system prompt', () => {
    expect(systemBlocks('a\n\nb', ['a', 'b'])).toHaveLength(2);
    expect(systemBlocks('a\n\nb', ['a', 'c'])).toEqual([{ type: 'text', text: 'a\n\nb', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(systemBlocks('a\n\nb', undefined)).toHaveLength(1);
  });

  it('marks a copy of the history, so a breakpoint never piles up in what is kept', () => {
    const history: History = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] },
    ];
    const marked = withConversationBreakpoint(history);
    expect(JSON.stringify(history)).not.toContain('cache_control');
    expect(JSON.stringify(marked).match(/cache_control/g)).toHaveLength(1);
    expect((marked.at(-1)!.content as { cache_control?: unknown }[]).at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('keeps a conversation to the system prompt it began with, whatever a later turn sends', async () => {
    const { client, sent } = fakeClient([answer, answer]);
    const backend = apiBackend(() => 'sk-test', { createClient: () => client });
    const first = await backend.beat(req(), new AbortController().signal);
    await backend.beat(
      req({ session: first.session, system: 'rules\n\nindex v2', systemBlocks: ['rules', 'index v2'], text: 'again' }),
      new AbortController().signal,
    );
    expect(sent[1]!.system.map((b) => b.text)).toEqual(['rules', 'index v1']);
    // …and the history is the same prefix plus the new turn
    expect(sent[1]!.messages).toHaveLength(3);
    const textOf = (m: Params['messages'][number]) => (typeof m.content === 'string' ? m.content : String(m.content[0]!.text));
    expect(textOf(sent[1]!.messages[0]!)).toBe(textOf(sent[0]!.messages[0]!));
  });
});

describe('the tool loop', () => {
  it('has no tools and never reaches the endpoint when the request does not ask for read tools', async () => {
    const endpoint = fakeEndpoint();
    const { done, sent } = run([answer], req(), endpoint);
    await done;
    expect(sent[0]!.tools).toBeUndefined();
    expect(endpoint.seen).toEqual([]);
  });

  it('offers the read tools the endpoint lists, and only those the server allowed', async () => {
    const { done, sent, endpoint } = run([answer], req({ readTools: true }));
    await done;
    expect(sent[0]!.tools!.map((t) => t.name)).toEqual(TOOLS);
    expect(endpoint.seen.map((s) => s.body.method)).toEqual(['tools/list']);
    expect(endpoint.seen[0]!.url).toBe('http://localhost:5401/mcp?scope=lookup');
  });

  it('calls a tool the model asked for through the endpoint, sends the result back, and answers', async () => {
    const endpoint = fakeEndpoint({ results: { get_plugin_details: { text: '- agstudio.reverb "Reverb"\n  params: decay: float 0.1..10 s = 2' } } });
    const { done, sent } = run(
      [toolUse('call-1', 'get_plugin_details', { ids: ['agstudio.reverb'] }), answer],
      req({ readTools: true }),
      endpoint,
    );
    const reply = await done;
    expect(reply.beat).toEqual({ message: 'Done.' });
    const call = endpoint.seen.find((s) => s.body.method === 'tools/call')!;
    expect(call.body.params).toEqual({ name: 'get_plugin_details', arguments: { ids: ['agstudio.reverb'] } });
    // the second request has the model's own turn (its thinking too, unchanged) and the tool's result
    expect(sent).toHaveLength(2);
    const [, assistant, results] = sent[1]!.messages;
    expect((assistant!.content as { type: string }[]).map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(results).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', content: expect.stringContaining('decay: float 0.1..10 s') }],
    });
    expect(countBreakpoints(sent[1]!)).toBe(3);
  });

  it('reads the access token from its file for the endpoint, and nowhere else', async () => {
    const endpoint = fakeEndpoint();
    const { done, sent } = run([toolUse('c', 'get_mixer', {}), answer], req({ readTools: true }), endpoint);
    await done;
    expect(endpoint.seen.length).toBeGreaterThanOrEqual(2);
    for (const call of endpoint.seen) expect(call.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(sent)).not.toContain(SECRET);
  });

  it('keeps the whole conversation, tool calls included, for the next turn', async () => {
    const endpoint = fakeEndpoint();
    const { client, sent } = fakeClient([toolUse('c', 'get_mixer', {}), answer, answer]);
    const backend = apiBackend(() => 'sk-test', { createClient: () => client, fetch: endpoint.fetchImpl });
    const first = await backend.beat(req({ readTools: true }), new AbortController().signal, access());
    await backend.beat(req({ readTools: true, session: first.session, text: 'more' }), new AbortController().signal, access());
    const kinds = sent[2]!.messages.map((m) => (typeof m.content === 'string' ? 'text' : (m.content as { type: string }[])[0]!.type));
    expect(kinds).toEqual(['text', 'thinking', 'tool_result', 'text', 'text']);
  });

  it('gives a tool that failed, or that does not exist, back to the model as an error result', async () => {
    const endpoint = fakeEndpoint({ results: { get_mixer: { text: 'there is no track 99', isError: true } } });
    const { done, sent } = run(
      [{ stop_reason: 'tool_use', content: [toolUse('a', 'get_mixer', { insert: '99' }).content[1], toolUse('b', 'apply_actions', {}).content[1]] }, answer],
      req({ readTools: true }),
      endpoint,
    );
    await done;
    const results = sent[1]!.messages.at(-1)!.content as unknown as { tool_use_id: string; is_error?: boolean; content: string }[];
    expect(results).toMatchObject([
      { tool_use_id: 'a', is_error: true, content: 'there is no track 99' },
      { tool_use_id: 'b', is_error: true, content: expect.stringContaining('no tool "apply_actions"') },
    ]);
    // the write tool the endpoint listed was never called, and was not offered
    expect(endpoint.seen.some((s) => s.body.params?.name === 'apply_actions')).toBe(false);
    expect(sent[0]!.tools!.map((t) => t.name)).not.toContain('apply_actions');
  });

  it('forbids tools for the last request when the model keeps asking, so it has to answer', async () => {
    const replies = Array.from({ length: MAX_LOOKUP_ROUNDS }, (_, i) => toolUse(`c${i}`, 'get_mixer', {}));
    const { done, sent } = run([...replies, answer], req({ readTools: true }));
    await done;
    expect(sent).toHaveLength(MAX_LOOKUP_ROUNDS + 1);
    expect(sent[0]!.tool_choice).toBeUndefined();
    expect(sent.at(-1)!.tool_choice).toEqual({ type: 'none' });
  });

  it('goes on without tools when the endpoint cannot be reached', async () => {
    const { done, sent } = run([answer], req({ readTools: true }), fakeEndpoint({ down: true }));
    const reply = await done;
    expect(reply.beat).toEqual({ message: 'Done.' });
    expect(sent[0]!.tools).toBeUndefined();
  });

  it('goes on without tools when the server has none to offer (no look-up access)', async () => {
    const endpoint = fakeEndpoint();
    const { done, sent } = run([answer], req({ readTools: true }), endpoint, null);
    await done;
    expect(sent[0]!.tools).toBeUndefined();
    expect(endpoint.seen).toEqual([]);
  });
});

describe('the answer', () => {
  it('is the last reply’s structured output', async () => {
    const reply = await run([toolUse('c', 'get_mixer', {}), text('{"message":"Final."}')], req({ readTools: true })).done;
    expect(reply.beat).toEqual({ message: 'Final.' });
  });

  it('is an error the musician can read when the model refuses, runs out of room, or answers with no JSON', async () => {
    const refused = run([{ stop_reason: 'refusal', content: [] }], req());
    await expect(refused.done).rejects.toMatchObject({ type: 'refusal' });
    const cut = run([{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"mess' }] }], req());
    await expect(cut.done).rejects.toMatchObject({ type: 'max_tokens' });
    const junk = run([text('sorry')], req());
    await expect(junk.done).rejects.toBeInstanceOf(AiServerError);
  });
});
