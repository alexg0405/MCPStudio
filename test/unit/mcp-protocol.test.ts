/// <reference types="node" />
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import {
  createMcpProtocol,
  LEGACY_VERSIONS,
  UnknownToolError,
  validateArguments,
  type HttpIn,
  type McpBackend,
} from '../../tools/mcp/protocol.ts';

/** The MCP server's JSON-RPC layer with a stand-in backend: both protocol eras, errors, validation. */

const V = 'io.modelcontextprotocol';
const NEW = '2026-07-28';

function backend(): McpBackend & { calls: unknown[][]; clients: unknown[] } {
  const calls: unknown[][] = [];
  const clients: unknown[] = [];
  return {
    calls,
    clients,
    tools: async () => [
      {
        name: 'echo',
        title: 'Echo',
        description: 'Says it back.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            times: { type: 'integer', minimum: 1, maximum: 3 },
            mode: { type: 'string', enum: ['a', 'b'] },
          },
          required: ['text'],
        },
      },
      { name: 'boom', title: 'Boom', description: 'Fails.', inputSchema: { type: 'object', properties: {} } },
    ],
    resources: async () => [
      { uri: 'agstudio://project', name: 'project', title: 'Project', description: 'd', mimeType: 'text/plain', tool: 'echo' },
    ],
    instructions: async () => 'How to use it.',
    call: async (name, args, client) => {
      calls.push([name, args, client]);
      if (name === 'boom') throw new Error('it broke');
      if (name === 'ghost') throw new UnknownToolError(name);
      return { content: [{ type: 'text', text: String((args as { text?: string }).text ?? 'hi') }] };
    },
    onClient: (c) => clients.push(c),
  };
}

const info = { name: 'agstudio', title: 'AGstudio', version: '0.1.0' };

const post = (body: unknown, headers: Record<string, string> = {}): HttpIn => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const modern = (method: string, params: Record<string, unknown> = {}, id: number | string = 1) => {
  const name = (params.name ?? params.uri) as string | undefined;
  return post(
    {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: { [`${V}/protocolVersion`]: NEW, [`${V}/clientInfo`]: { name: 'claude-code', version: '9' }, [`${V}/clientCapabilities`]: {} },
      },
    },
    { 'mcp-protocol-version': NEW, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) },
  );
};

type Rpc = { result?: Record<string, any>; error?: { code: number; message: string; data?: any }; id: unknown };
const json = (r: { body?: unknown }) => r.body as Rpc;

describe('MCP protocol: the 2025 handshake', () => {
  it('negotiates the version, declares tools and resources, and hands out a session', async () => {
    const b = backend();
    const p = createMcpProtocol(b, info);
    const r = await p.handle(
      post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0' } } }),
    );
    expect(r.status).toBe(200);
    expect(json(r).result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'agstudio', version: '0.1.0' },
      instructions: 'How to use it.',
    });
    expect(r.headers?.['mcp-session-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.clients).toEqual([{ name: 'claude-code', version: '2.0' }]);
  });

  it('answers a version it does not know with the newest one it speaks', async () => {
    const p = createMcpProtocol(backend(), info);
    for (const asked of ['1999-01-01', '2024-11-05', '2026-07-28', 7]) {
      const r = await p.handle(post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: asked } }));
      expect(json(r).result?.protocolVersion).toBe(LEGACY_VERSIONS[0]);
    }
  });

  it('accepts notifications/initialized with 202 and no body', async () => {
    const p = createMcpProtocol(backend(), info);
    const r = await p.handle(post({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(r).toEqual({ status: 202 });
  });

  it('remembers who the client is for later calls in the session', async () => {
    const b = backend();
    const p = createMcpProtocol(b, info);
    const init = await p.handle(
      post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'Claude Desktop' } } }),
    );
    const session = init.headers!['mcp-session-id']!;
    await p.handle(
      post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } }, { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' }),
    );
    expect(b.calls[0]![2]).toEqual({ name: 'Claude Desktop' });
    // No session: still served, as an unnamed app.
    await p.handle(post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'y' } } }));
    expect(b.calls[1]![2]).toBeUndefined();
  });

  it('lists tools without a resultType and answers ping', async () => {
    const p = createMcpProtocol(backend(), info);
    const r = await p.handle(post({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' }));
    expect(json(r).result?.tools.map((t: { name: string }) => t.name)).toEqual(['echo', 'boom']);
    expect(json(r).result).not.toHaveProperty('resultType');
    expect(json(r).id).toBe(5);
    expect(json(await p.handle(post({ jsonrpc: '2.0', id: 'p', method: 'ping' }))).result).toEqual({});
  });

  it('serves a JSON-RPC batch', async () => {
    const p = createMcpProtocol(backend(), info);
    const r = await p.handle(post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]));
    expect(r.status).toBe(200);
    expect((r.body as unknown[]).length).toBe(2);
    expect((await p.handle(post([{ jsonrpc: '2.0', method: 'notifications/initialized' }]))).status).toBe(202);
    expect((await p.handle(post([]))).status).toBe(400);
  });
});

describe('MCP protocol: the 2026-07-28 stateless era', () => {
  it('describes itself on server/discover', async () => {
    const b = backend();
    const p = createMcpProtocol(b, info);
    const r = await p.handle(modern('server/discover'));
    expect(r.status).toBe(200);
    expect(json(r).result).toMatchObject({
      resultType: 'complete',
      supportedVersions: [NEW],
      capabilities: { tools: {}, resources: {} },
      instructions: 'How to use it.',
      _meta: { [`${V}/serverInfo`]: { name: 'agstudio' } },
    });
    expect(b.clients).toEqual([{ name: 'claude-code', version: '9' }]);
  });

  it('lists tools and runs one, naming the client from _meta', async () => {
    const b = backend();
    const p = createMcpProtocol(b, info);
    const list = await p.handle(modern('tools/list'));
    expect(json(list).result).toMatchObject({ resultType: 'complete' });
    const call = await p.handle(modern('tools/call', { name: 'echo', arguments: { text: 'hello' } }));
    expect(call.status).toBe(200);
    expect(json(call).result).toMatchObject({ resultType: 'complete', content: [{ type: 'text', text: 'hello' }] });
    expect(b.calls[0]).toEqual(['echo', { text: 'hello' }, { name: 'claude-code', version: '9' }]);
  });

  it('rejects a request without client capabilities (400, invalid params)', async () => {
    const p = createMcpProtocol(backend(), info);
    const r = await p.handle(
      post(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [`${V}/protocolVersion`]: NEW } } },
        { 'mcp-protocol-version': NEW, 'mcp-method': 'tools/list' },
      ),
    );
    expect(r.status).toBe(400);
    expect(json(r).error?.code).toBe(-32602);
  });

  it('rejects headers that disagree with the body (400, -32020)', async () => {
    const p = createMcpProtocol(backend(), info);
    const good = modern('tools/call', { name: 'echo', arguments: { text: 'a' } });
    for (const headers of [
      { ...good.headers, 'mcp-protocol-version': '2025-06-18' },
      { ...good.headers, 'mcp-method': 'tools/list' },
      { ...good.headers, 'mcp-name': 'boom' },
      Object.fromEntries(Object.entries(good.headers).filter(([k]) => k !== 'mcp-name')),
      Object.fromEntries(Object.entries(good.headers).filter(([k]) => k !== 'mcp-method')),
    ]) {
      const r = await p.handle({ ...good, headers });
      expect(r.status).toBe(400);
      expect(json(r).error?.code, JSON.stringify(headers)).toBe(-32020);
    }
  });

  it('decodes a base64 Mcp-Name', async () => {
    const p = createMcpProtocol(backend(), info);
    const good = modern('tools/call', { name: 'echo', arguments: { text: 'a' } });
    const r = await p.handle({ ...good, headers: { ...good.headers, 'mcp-name': `=?base64?${Buffer.from('echo').toString('base64')}?=` } });
    expect(r.status).toBe(200);
  });

  it('refuses an unknown protocol version with the versions it supports (400, -32022)', async () => {
    const p = createMcpProtocol(backend(), info);
    const r = await p.handle(
      post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [`${V}/protocolVersion`]: '1900-01-01', [`${V}/clientCapabilities`]: {} } } }, { 'mcp-protocol-version': '1900-01-01' }),
    );
    expect(r.status).toBe(400);
    expect(json(r).error).toMatchObject({ code: -32022, data: { requested: '1900-01-01', supported: [NEW, ...LEGACY_VERSIONS] } });
  });

  it('answers an unknown method with 404 and -32601', async () => {
    const r = await createMcpProtocol(backend(), info).handle(modern('prompts/list'));
    expect(r.status).toBe(404);
    expect(json(r).error?.code).toBe(-32601);
  });
});

describe('MCP protocol: tools and resources', () => {
  const call = (p: ReturnType<typeof createMcpProtocol>, name: unknown, args?: unknown) =>
    p.handle(post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, ...(args === undefined ? {} : { arguments: args }) } }));

  it('returns an unknown tool as a protocol error', async () => {
    const p = createMcpProtocol(backend(), info);
    expect(json(await call(p, 'nope', {})).error).toMatchObject({ code: -32602, message: 'Unknown tool: nope' });
    expect(json(await call(p, 42)).error?.code).toBe(-32602);
    expect(json(await call(p, 'echo', 'not an object')).error?.code).toBe(-32602);
  });

  it('returns a tool that throws as an isError result the AI can read', async () => {
    const p = createMcpProtocol(backend(), info);
    const r = json(await call(p, 'boom', {}));
    expect(r.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'it broke' }] });
    expect(r.error).toBeUndefined();
  });

  it('checks the arguments against the schema before running the tool', async () => {
    const b = backend();
    const p = createMcpProtocol(b, info);
    for (const [args, problem] of [
      [{}, /text is required/],
      [{ text: 5 }, /text must be a string/],
      [{ text: 'a', times: 9 }, /times must be at most 3/],
      [{ text: 'a', times: 1.5 }, /times must be an integer/],
      [{ text: 'a', mode: 'z' }, /mode must be one of: a, b/],
      [{ text: 'a', extra: 1 }, /extra is not a known option/],
    ] as const) {
      const r = json(await call(p, 'echo', args));
      expect(r.result?.isError, JSON.stringify(args)).toBe(true);
      expect(r.result?.content[0].text).toMatch(problem);
    }
    expect(b.calls).toHaveLength(0);
    expect(json(await call(p, 'echo', { text: 'ok', times: 2 })).result?.isError).toBeUndefined();
  });

  it('lists resources without the tool behind them and reads one', async () => {
    const p = createMcpProtocol(backend(), info);
    const list = await p.handle(post({ jsonrpc: '2.0', id: 1, method: 'resources/list' }));
    expect(json(list).result?.resources).toEqual([{ uri: 'agstudio://project', name: 'project', title: 'Project', description: 'd', mimeType: 'text/plain' }]);
    const read = await p.handle(post({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'agstudio://project' } }));
    expect(json(read).result?.contents).toEqual([{ uri: 'agstudio://project', mimeType: 'text/plain', text: 'hi' }]);
    const bad = await p.handle(post({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'agstudio://x' } }));
    expect(json(bad).error?.code).toBe(-32602);
  });
});

describe('MCP protocol: transport rules and malformed input', () => {
  it('answers GET and DELETE with 405 (there is no event stream)', async () => {
    const p = createMcpProtocol(backend(), info);
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const r = await p.handle({ method, headers: {}, body: '' });
      expect(r.status).toBe(405);
      expect(r.headers?.allow).toBe('POST');
    }
  });

  it('reports bad JSON and non-JSON-RPC bodies', async () => {
    const p = createMcpProtocol(backend(), info);
    const parse = await p.handle(post('{nope'));
    expect(parse.status).toBe(400);
    expect(json(parse).error?.code).toBe(-32700);
    for (const body of [{ id: 1, method: 'ping' }, 'null', '"x"', { jsonrpc: '2.0', id: 1 }]) {
      const r = await p.handle(post(typeof body === 'string' ? body : body));
      expect(r.status).toBe(400);
      expect(json(r).error?.code).toBe(-32600);
    }
  });

  it('accepts a response from the client with 202 (it never gets a request to answer)', async () => {
    const p = createMcpProtocol(backend(), info);
    expect((await p.handle(post({ jsonrpc: '2.0', id: 1, result: {} }))).status).toBe(202);
  });

  it('turns a backend crash into a 500 JSON-RPC error', async () => {
    const b = backend();
    b.tools = vi.fn().mockRejectedValue(new Error('no tools module'));
    const r = await createMcpProtocol(b, info).handle(post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(r.status).toBe(500);
    expect(json(r).error?.message).toBe('no tools module');
  });
});

describe('validateArguments', () => {
  it('walks nested objects and ignores what it does not understand', () => {
    const schema = {
      type: 'object',
      properties: { focus: { type: 'object', properties: { from_bar: { type: 'integer', minimum: 1 } }, required: ['from_bar'] }, list: { type: 'array' }, any: {} },
    };
    expect(validateArguments(schema, { focus: { from_bar: 0 }, list: [], any: 'x' })).toEqual(['focus.from_bar must be at least 1']);
    expect(validateArguments(schema, { focus: {} })).toEqual(['focus.from_bar is required']);
    expect(validateArguments(schema, { list: 'no' })).toEqual(['list must be an array']);
    expect(validateArguments(schema, [])).toEqual(['the arguments must be an object']);
  });
});
