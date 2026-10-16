import { randomUUID } from 'node:crypto';
import type { ClientInfo, ResourceDef, ToolDef, ToolResult } from '../../src/app/mcp/types.ts';

/**
 * AGstudio's MCP server, as pure JSON-RPC 2.0 over HTTP: no sockets, no Vite, so it is unit-tested
 * with plain objects. `tools/mcp/server.ts` puts it behind `POST /mcp`.
 *
 * Implemented subset of the Model Context Protocol, serving two eras of the Streamable HTTP
 * transport at the same endpoint (the spec's "dual-era server"):
 *  - 2026-07-28 (stateless): no handshake; every request carries `_meta` with the protocol version
 *    and client capabilities, plus the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers,
 *    which are checked against the body (HTTP 400, error -32020 on a mismatch, -32022 for an
 *    unknown version). `server/discover` describes the server.
 *  - 2025-11-25, 2025-06-18, 2025-03-26: `initialize` (version negotiation, capabilities,
 *    instructions), `notifications/initialized` (202), an `Mcp-Session-Id` that remembers who the
 *    client is, the `MCP-Protocol-Version` header, JSON-RPC batches (2025-03-26 only by the spec,
 *    harmless otherwise).
 * Both: `ping`, `tools/list`, `tools/call` (text, image and audio content, `structuredContent`,
 * `isError`), `resources/list`, `resources/read`, `resources/templates/list`. Replies are always
 * plain JSON (no SSE stream is needed: nothing is pushed to the client); GET and DELETE answer 405.
 * Not implemented: prompts, logging, sampling, subscriptions, the 2024-11-05 HTTP+SSE transport.
 */

export const MODERN_VERSIONS = ['2026-07-28'] as const;
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const V = 'io.modelcontextprotocol';
const isModern = (v: string) => (MODERN_VERSIONS as readonly string[]).includes(v);
const isLegacy = (v: string) => (LEGACY_VERSIONS as readonly string[]).includes(v);

export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const;

export class UnknownToolError extends Error {}

export interface McpBackend {
  tools(): Promise<readonly ToolDef[]>;
  resources(): Promise<readonly ResourceDef[]>;
  instructions(): Promise<string>;
  /** Runs a tool. Throws UnknownToolError for a name it doesn't have; anything else thrown becomes an `isError` result. */
  call(name: string, args: Record<string, unknown>, client: ClientInfo | undefined): Promise<ToolResult>;
  /** An app said hello (initialize, discover or its first call). */
  onClient?(client: ClientInfo | undefined): void;
}

export interface HttpIn {
  method: string;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HttpOut {
  status: number;
  headers?: Record<string, string>;
  /** JSON-serializable; undefined = empty body. */
  body?: unknown;
}

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0' as const,
  id: id === undefined ? null : id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

/** `Mcp-Name` values that aren't plain ASCII travel as `=?base64?…?=`. */
function decodeHeaderValue(v: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : v;
}

/** Checks tool arguments against the tool's JSON Schema (the parts the tools use). Returns the problems. */
export function validateArguments(schema: unknown, value: unknown, path = ''): string[] {
  if (!isObj(schema)) return [];
  const where = path || 'the arguments';
  const problems: string[] = [];
  const type = schema.type;
  const typeOk = (t: string): boolean =>
    t === 'object'
      ? isObj(value)
      : t === 'array'
        ? Array.isArray(value)
        : t === 'string'
          ? typeof value === 'string'
          : t === 'boolean'
            ? typeof value === 'boolean'
            : t === 'integer'
              ? typeof value === 'number' && Number.isInteger(value)
              : t === 'number'
                ? typeof value === 'number' && Number.isFinite(value)
                : t === 'null'
                  ? value === null
                  : true;
  if (typeof type === 'string' && !typeOk(type)) return [`${where} must be ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`];
  if (Array.isArray(type) && !type.some((t) => typeof t === 'string' && typeOk(t))) return [`${where} must be ${type.join(' or ')}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    problems.push(`${where} must be one of: ${schema.enum.map(String).join(', ')}`);
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${where} must be at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${where} must be at most ${schema.maximum}`);
  }
  if (isObj(value) && isObj(schema.properties)) {
    for (const key of Array.isArray(schema.required) ? schema.required : [])
      if (typeof key === 'string' && value[key] === undefined) problems.push(`${path ? `${path}.` : ''}${key} is required`);
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties[key];
      if (sub === undefined) {
        if (schema.additionalProperties === false) problems.push(`${path ? `${path}.` : ''}${key} is not a known option`);
      } else if (v !== undefined) problems.push(...validateArguments(sub, v, `${path ? `${path}.` : ''}${key}`));
    }
  }
  return problems;
}

export function createMcpProtocol(backend: McpBackend, info: ServerInfo) {
  /** Legacy sessions: who the client said it was at `initialize`. Small and bounded. */
  const sessions = new Map<string, ClientInfo | undefined>();

  const capabilities = { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } };
  const metaOf = () => ({ [`${V}/serverInfo`]: { name: info.name, version: info.version } });

  const clientFromMeta = (params: Json | undefined): ClientInfo | undefined => {
    const m = params && isObj(params._meta) ? params._meta[`${V}/clientInfo`] : undefined;
    return clientOf(m);
  };
  const clientOf = (v: unknown): ClientInfo | undefined =>
    isObj(v) && typeof v.name === 'string' && v.name
      ? { name: v.name.slice(0, 80), ...(typeof v.version === 'string' ? { version: v.version.slice(0, 40) } : {}) }
      : undefined;

  interface Ctx {
    version: string;
    modern: boolean;
    client: ClientInfo | undefined;
  }

  /** A successful result; 2026-07-28 results say `resultType` and who the server is. */
  const ok = (id: unknown, ctx: Ctx, result: Json) => ({
    jsonrpc: '2.0' as const,
    id,
    result: ctx.modern ? { resultType: 'complete', ...result, _meta: { ...(isObj(result._meta) ? result._meta : {}), ...metaOf() } } : result,
  });

  async function dispatch(msg: Json, ctx: Ctx): Promise<{ status: number; reply: Json; headers?: Record<string, string> }> {
    const id = msg.id;
    const method = msg.method as string;
    const params = isObj(msg.params) ? msg.params : undefined;
    const fine = (result: Json, headers?: Record<string, string>) => ({
      status: 200,
      reply: ok(id, ctx, result),
      ...(headers ? { headers } : {}),
    });
    const fail = (status: number, code: number, message: string, data?: unknown) => ({
      status,
      reply: rpcError(id, code, message, data),
    });

    switch (method) {
      case 'ping':
        return fine({});

      case 'initialize': {
        const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const version = isLegacy(asked) ? asked : LEGACY_VERSIONS[0];
        const client = clientOf(params?.clientInfo);
        const session = randomUUID();
        sessions.set(session, client);
        while (sessions.size > 64) sessions.delete(sessions.keys().next().value as string);
        backend.onClient?.(client);
        return {
          status: 200,
          headers: { 'mcp-session-id': session },
          reply: {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: version,
              capabilities,
              serverInfo: { name: info.name, title: info.title, version: info.version },
              instructions: await backend.instructions(),
            },
          },
        };
      }

      case 'server/discover':
        backend.onClient?.(ctx.client);
        return fine({
          supportedVersions: [...MODERN_VERSIONS],
          capabilities,
          instructions: await backend.instructions(),
        });

      case 'tools/list':
        return fine({ tools: await backend.tools() });

      case 'tools/call': {
        const name = params?.name;
        if (typeof name !== 'string') return fail(200, ERR.invalidParams, 'tools/call needs a tool name');
        const args = params?.arguments === undefined ? {} : params.arguments;
        if (!isObj(args)) return fail(200, ERR.invalidParams, 'The tool arguments must be an object');
        const tool = (await backend.tools()).find((t) => t.name === name);
        if (!tool) return fail(200, ERR.invalidParams, `Unknown tool: ${name}`);
        const problems = validateArguments(tool.inputSchema, args);
        if (problems.length)
          return fine(errorResult(`Can't run ${name}: ${problems.slice(0, 8).join('; ')}.`) as unknown as Json);
        try {
          return fine((await backend.call(name, args, ctx.client)) as unknown as Json);
        } catch (e) {
          if (e instanceof UnknownToolError) return fail(200, ERR.invalidParams, `Unknown tool: ${name}`);
          return fine(errorResult(e instanceof Error ? e.message : String(e)) as unknown as Json);
        }
      }

      case 'resources/list':
        return fine({
          resources: (await backend.resources()).map(({ tool: _tool, ...r }) => r),
        });

      case 'resources/templates/list':
        return fine({ resourceTemplates: [] });

      case 'resources/read': {
        const uri = params?.uri;
        const res = (await backend.resources()).find((r) => r.uri === uri);
        if (!res) return fail(200, ERR.invalidParams, `Unknown resource: ${String(uri)}`);
        const out = await backend.call(res.tool, {}, ctx.client);
        const text = out.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        if (out.isError) return fail(200, ERR.internal, text || 'AGstudio could not read that');
        return fine({ contents: [{ uri: res.uri, mimeType: res.mimeType, text }] });
      }

      default:
        return fail(ctx.modern ? 404 : 200, ERR.methodNotFound, `Method not found: ${method}`);
    }
  }

  /** Validates the 2026-07-28 request metadata and headers; the error to send, or null. */
  function checkModern(msg: Json, headers: HttpIn['headers'], version: string): HttpOut | null {
    const params = isObj(msg.params) ? msg.params : undefined;
    const meta = params && isObj(params._meta) ? params._meta : {};
    const bad = (status: number, code: number, text: string, data?: unknown): HttpOut => ({
      status,
      body: rpcError(msg.id, code, text, data),
    });
    if (!isObj(meta[`${V}/clientCapabilities`]))
      return bad(400, ERR.invalidParams, `Every request needs _meta["${V}/clientCapabilities"] (an object, may be empty)`);
    const header = headers['mcp-protocol-version'];
    if (header !== version)
      return bad(400, ERR.headerMismatch, `Header mismatch: MCP-Protocol-Version is ${header ?? 'missing'} but the request says ${version}`);
    const method = headers['mcp-method'];
    if (method !== msg.method)
      return bad(400, ERR.headerMismatch, `Header mismatch: Mcp-Method is ${method ?? 'missing'} but the request is ${String(msg.method)}`);
    if (msg.method === 'tools/call' || msg.method === 'resources/read') {
      const body = msg.method === 'tools/call' ? params?.name : params?.uri;
      const given = headers['mcp-name'];
      if (given === undefined || decodeHeaderValue(given) !== body)
        return bad(400, ERR.headerMismatch, `Header mismatch: Mcp-Name is ${given ?? 'missing'} but the request says ${String(body)}`);
    }
    return null;
  }

  async function one(msg: unknown, headers: HttpIn['headers']): Promise<HttpOut & { reply?: Json }> {
    if (!isObj(msg) || msg.jsonrpc !== '2.0')
      return { status: 400, body: rpcError(null, ERR.invalidRequest, 'Not a JSON-RPC 2.0 message') };
    // A response from the client (to a request we never send): nothing to do.
    if (typeof msg.method !== 'string') return isObj(msg) && ('result' in msg || 'error' in msg) ? { status: 202 } : { status: 400, body: rpcError(msg.id, ERR.invalidRequest, 'Missing method') };
    const isRequest = msg.id !== undefined && msg.id !== null && (typeof msg.id === 'string' || typeof msg.id === 'number');
    if (!isRequest) {
      // A notification (notifications/initialized, notifications/cancelled…): accepted, nothing to answer.
      return { status: 202 };
    }
    const params = isObj(msg.params) ? msg.params : undefined;
    const meta = params && isObj(params._meta) ? params._meta : undefined;
    const bodyVersion = meta && typeof meta[`${V}/protocolVersion`] === 'string' ? (meta[`${V}/protocolVersion`] as string) : undefined;
    const headerVersion = headers['mcp-protocol-version'];

    let ctx: Ctx;
    if (msg.method === 'initialize') {
      ctx = { version: LEGACY_VERSIONS[0], modern: false, client: undefined };
    } else {
      // No version anywhere: an old client that never sent the header (the spec's default for those).
      const version = bodyVersion ?? headerVersion ?? '2025-03-26';
      if (!SUPPORTED_VERSIONS.includes(version))
        return {
          status: 400,
          body: rpcError(msg.id, ERR.unsupportedVersion, 'Unsupported protocol version', {
            supported: [...SUPPORTED_VERSIONS],
            requested: version,
          }),
        };
      if (isModern(version)) {
        const err = checkModern(msg, headers, version);
        if (err) return err;
        ctx = { version, modern: true, client: clientFromMeta(params) };
      } else {
        const session = headers['mcp-session-id'];
        ctx = { version, modern: false, client: session ? sessions.get(session) : undefined };
      }
    }
    const out = await dispatch(msg, ctx);
    return { status: out.status, ...(out.headers ? { headers: out.headers } : {}), body: out.reply, reply: out.reply };
  }

  return {
    async handle(req: HttpIn): Promise<HttpOut> {
      if (req.method !== 'POST')
        return {
          status: 405,
          headers: { allow: 'POST' },
          body: rpcError(null, ERR.invalidRequest, 'Use POST: this server has no event stream to open.'),
        };
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body);
      } catch {
        return { status: 400, body: rpcError(null, ERR.parse, 'The request body is not valid JSON.') };
      }
      try {
        if (Array.isArray(parsed)) {
          if (parsed.length === 0) return { status: 400, body: rpcError(null, ERR.invalidRequest, 'Empty batch') };
          const outs = await Promise.all(parsed.map((m) => one(m, req.headers)));
          const replies = outs.map((o) => o.body).filter((b) => b !== undefined);
          return replies.length ? { status: 200, body: replies } : { status: 202 };
        }
        return await one(parsed, req.headers);
      } catch (e) {
        return { status: 500, body: rpcError(null, ERR.internal, e instanceof Error ? e.message : String(e)) };
      }
    },
  };
}

export const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
