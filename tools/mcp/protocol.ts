import { randomUUID } from 'node:crypto';
import type { ClientInfo, ResourceDef, ToolDef, ToolResult } from '../../src/app/mcp/types.ts';
import { validateArguments } from './validate-arguments.ts';

export { validateArguments };

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

/** Namespace of the protocol's `_meta` keys ("io.modelcontextprotocol/clientInfo", ...). */
const META_NAMESPACE = 'io.modelcontextprotocol';
const isModern = (v: string) => (MODERN_VERSIONS as readonly string[]).includes(v);
const isLegacy = (v: string) => (LEGACY_VERSIONS as readonly string[]).includes(v);
/** The version assumed for an old client that never says which one it speaks (the spec's default for those). */
const DEFAULT_LEGACY_VERSION = '2025-03-26';
/** Legacy sessions remembered at once: a small bound so a misbehaving client can't grow the map. */
const MAX_SESSIONS = 64;
const MAX_CLIENT_NAME_LENGTH = 80;
const MAX_CLIENT_VERSION_LENGTH = 40;
/** The most problems listed in a tool-argument error message. */
const MAX_PROBLEMS_SHOWN = 8;

/** JSON-RPC and MCP error codes. */
export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const;

/** Thrown by a backend for a tool name it does not have. */
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

/** The client's name and version from a `clientInfo` value, shortened; undefined when it names no client. */
const clientOf = (v: unknown): ClientInfo | undefined =>
  isObj(v) && typeof v.name === 'string' && v.name
    ? {
        name: v.name.slice(0, MAX_CLIENT_NAME_LENGTH),
        ...(typeof v.version === 'string' ? { version: v.version.slice(0, MAX_CLIENT_VERSION_LENGTH) } : {}),
      }
    : undefined;

const clientFromMeta = (params: Json | undefined): ClientInfo | undefined => {
  const info = params && isObj(params._meta) ? params._meta[`${META_NAMESPACE}/clientInfo`] : undefined;
  return clientOf(info);
};

/** What one request is about: the protocol era it speaks and who the client is. */
interface RequestContext {
  version: string;
  modern: boolean;
  client: ClientInfo | undefined;
}

/** What `dispatch` decided: the HTTP status, the JSON-RPC reply and any extra headers. */
interface Dispatched {
  status: number;
  reply: Json;
  headers?: Record<string, string>;
}

/** Validates the 2026-07-28 request metadata and headers; the error to send, or null. */
function checkModernRequest(msg: Json, headers: HttpIn['headers'], version: string): HttpOut | null {
  const params = isObj(msg.params) ? msg.params : undefined;
  const meta = params && isObj(params._meta) ? params._meta : {};
  const bad = (status: number, code: number, text: string, data?: unknown): HttpOut => ({
    status,
    body: rpcError(msg.id, code, text, data),
  });
  if (!isObj(meta[`${META_NAMESPACE}/clientCapabilities`])) {
    return bad(
      400,
      ERR.invalidParams,
      `Every request needs _meta["${META_NAMESPACE}/clientCapabilities"] (an object, may be empty)`,
    );
  }
  const header = headers['mcp-protocol-version'];
  if (header !== version) {
    return bad(
      400,
      ERR.headerMismatch,
      `Header mismatch: MCP-Protocol-Version is ${header ?? 'missing'} but the request says ${version}`,
    );
  }
  const method = headers['mcp-method'];
  if (method !== msg.method) {
    return bad(
      400,
      ERR.headerMismatch,
      `Header mismatch: Mcp-Method is ${method ?? 'missing'} but the request is ${String(msg.method)}`,
    );
  }
  if (msg.method === 'tools/call' || msg.method === 'resources/read') {
    const bodyName = msg.method === 'tools/call' ? params?.name : params?.uri;
    const given = headers['mcp-name'];
    if (given === undefined || decodeHeaderValue(given) !== bodyName) {
      return bad(
        400,
        ERR.headerMismatch,
        `Header mismatch: Mcp-Name is ${given ?? 'missing'} but the request says ${String(bodyName)}`,
      );
    }
  }
  return null;
}

const CAPABILITIES = { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } };

/** The protocol's state (the legacy sessions) and its request handling. */
class McpProtocol {
  /** Legacy sessions: who the client said it was at `initialize`. Small and bounded. */
  private readonly sessions = new Map<string, ClientInfo | undefined>();

  constructor(
    private readonly backend: McpBackend,
    private readonly info: ServerInfo,
  ) {}

  /** One HTTP request: a message, or a batch of them. */
  async handle(req: HttpIn): Promise<HttpOut> {
    if (req.method !== 'POST') {
      return {
        status: 405,
        headers: { allow: 'POST' },
        body: rpcError(null, ERR.invalidRequest, 'Use POST: this server has no event stream to open.'),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      return { status: 400, body: rpcError(null, ERR.parse, 'The request body is not valid JSON.') };
    }
    try {
      if (Array.isArray(parsed)) return await this.handleBatch(parsed, req.headers);
      return await this.handleMessage(parsed, req.headers);
    } catch (e) {
      return { status: 500, body: rpcError(null, ERR.internal, e instanceof Error ? e.message : String(e)) };
    }
  }

  private async handleBatch(batch: unknown[], headers: HttpIn['headers']): Promise<HttpOut> {
    if (batch.length === 0) return { status: 400, body: rpcError(null, ERR.invalidRequest, 'Empty batch') };
    const outs = await Promise.all(batch.map((m) => this.handleMessage(m, headers)));
    const replies = outs.map((o) => o.body).filter((b) => b !== undefined);
    return replies.length ? { status: 200, body: replies } : { status: 202 };
  }

  /** One JSON-RPC message: checked, given its context, dispatched. */
  private async handleMessage(msg: unknown, headers: HttpIn['headers']): Promise<HttpOut & { reply?: Json }> {
    if (!isObj(msg) || msg.jsonrpc !== '2.0') {
      return { status: 400, body: rpcError(null, ERR.invalidRequest, 'Not a JSON-RPC 2.0 message') };
    }
    if (typeof msg.method !== 'string') {
      // A response from the client (to a request we never send): nothing to do.
      const isResponse = 'result' in msg || 'error' in msg;
      return isResponse
        ? { status: 202 }
        : { status: 400, body: rpcError(msg.id, ERR.invalidRequest, 'Missing method') };
    }
    const isRequest =
      msg.id !== undefined && msg.id !== null && (typeof msg.id === 'string' || typeof msg.id === 'number');
    // A notification (notifications/initialized, notifications/cancelled…): accepted, nothing to answer.
    if (!isRequest) return { status: 202 };

    const context = this.contextFor(msg, headers);
    if ('status' in context) return context;
    const out = await this.dispatch(msg, context);
    return { status: out.status, ...(out.headers ? { headers: out.headers } : {}), body: out.reply, reply: out.reply };
  }

  /** The protocol era and client of a request, or the error to send when its version or metadata is wrong. */
  private contextFor(msg: Json, headers: HttpIn['headers']): RequestContext | HttpOut {
    if (msg.method === 'initialize') return { version: LEGACY_VERSIONS[0], modern: false, client: undefined };
    const params = isObj(msg.params) ? msg.params : undefined;
    const meta = params && isObj(params._meta) ? params._meta : undefined;
    const metaVersion = meta?.[`${META_NAMESPACE}/protocolVersion`];
    const bodyVersion = typeof metaVersion === 'string' ? metaVersion : undefined;
    // No version anywhere: an old client that never sent the header.
    const version = bodyVersion ?? headers['mcp-protocol-version'] ?? DEFAULT_LEGACY_VERSION;
    if (!SUPPORTED_VERSIONS.includes(version)) {
      return {
        status: 400,
        body: rpcError(msg.id, ERR.unsupportedVersion, 'Unsupported protocol version', {
          supported: [...SUPPORTED_VERSIONS],
          requested: version,
        }),
      };
    }
    if (isModern(version)) {
      const error = checkModernRequest(msg, headers, version);
      return error ?? { version, modern: true, client: clientFromMeta(params) };
    }
    const sessionId = headers['mcp-session-id'];
    return { version, modern: false, client: sessionId ? this.sessions.get(sessionId) : undefined };
  }

  /** A successful result; 2026-07-28 results say `resultType` and who the server is. */
  private ok(id: unknown, context: RequestContext, result: Json) {
    const serverMeta = { [`${META_NAMESPACE}/serverInfo`]: { name: this.info.name, version: this.info.version } };
    return {
      jsonrpc: '2.0' as const,
      id,
      result: context.modern
        ? {
            resultType: 'complete',
            ...result,
            _meta: { ...(isObj(result._meta) ? result._meta : {}), ...serverMeta },
          }
        : result,
    };
  }

  private async dispatch(msg: Json, context: RequestContext): Promise<Dispatched> {
    const id = msg.id;
    const method = msg.method as string;
    const params = isObj(msg.params) ? msg.params : undefined;
    const fine = (result: Json, headers?: Record<string, string>): Dispatched => ({
      status: 200,
      reply: this.ok(id, context, result),
      ...(headers ? { headers } : {}),
    });
    const fail = (status: number, code: number, message: string): Dispatched => ({
      status,
      reply: rpcError(id, code, message),
    });

    switch (method) {
      case 'ping':
        return fine({});
      case 'initialize':
        return this.initialize(id, params);
      case 'server/discover':
        this.backend.onClient?.(context.client);
        return fine({
          supportedVersions: [...MODERN_VERSIONS],
          capabilities: CAPABILITIES,
          instructions: await this.backend.instructions(),
        });
      case 'tools/list':
        return fine({ tools: await this.backend.tools() });
      case 'tools/call':
        return this.callTool(params, context, fine, fail);
      case 'resources/list':
        return fine({ resources: (await this.backend.resources()).map(({ tool: _tool, ...r }) => r) });
      case 'resources/templates/list':
        return fine({ resourceTemplates: [] });
      case 'resources/read':
        return this.readResource(params, context, fine, fail);
      default:
        return fail(context.modern ? 404 : 200, ERR.methodNotFound, `Method not found: ${method}`);
    }
  }

  /** Legacy handshake: negotiates the version, remembers the client under a new session id. */
  private async initialize(id: unknown, params: Json | undefined): Promise<Dispatched> {
    const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = isLegacy(asked) ? asked : LEGACY_VERSIONS[0];
    const client = clientOf(params?.clientInfo);
    const session = randomUUID();
    this.sessions.set(session, client);
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
    this.backend.onClient?.(client);
    return {
      status: 200,
      headers: { 'mcp-session-id': session },
      reply: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: version,
          capabilities: CAPABILITIES,
          serverInfo: { name: this.info.name, title: this.info.title, version: this.info.version },
          instructions: await this.backend.instructions(),
        },
      },
    };
  }

  private async callTool(
    params: Json | undefined,
    context: RequestContext,
    fine: (result: Json) => Dispatched,
    fail: (status: number, code: number, message: string) => Dispatched,
  ): Promise<Dispatched> {
    const name = params?.name;
    if (typeof name !== 'string') return fail(200, ERR.invalidParams, 'tools/call needs a tool name');
    const args = params?.arguments === undefined ? {} : params.arguments;
    if (!isObj(args)) return fail(200, ERR.invalidParams, 'The tool arguments must be an object');
    const tool = (await this.backend.tools()).find((t) => t.name === name);
    if (!tool) return fail(200, ERR.invalidParams, `Unknown tool: ${name}`);
    const problems = validateArguments(tool.inputSchema, args);
    if (problems.length) {
      const shown = problems.slice(0, MAX_PROBLEMS_SHOWN).join('; ');
      return fine(errorResult(`Can't run ${name}: ${shown}.`) as unknown as Json);
    }
    try {
      return fine((await this.backend.call(name, args, context.client)) as unknown as Json);
    } catch (e) {
      if (e instanceof UnknownToolError) return fail(200, ERR.invalidParams, `Unknown tool: ${name}`);
      return fine(errorResult(e instanceof Error ? e.message : String(e)) as unknown as Json);
    }
  }

  /** A resource is read by running the tool it stands for and returning its text. */
  private async readResource(
    params: Json | undefined,
    context: RequestContext,
    fine: (result: Json) => Dispatched,
    fail: (status: number, code: number, message: string) => Dispatched,
  ): Promise<Dispatched> {
    const uri = params?.uri;
    const resource = (await this.backend.resources()).find((r) => r.uri === uri);
    if (!resource) return fail(200, ERR.invalidParams, `Unknown resource: ${String(uri)}`);
    const out = await this.backend.call(resource.tool, {}, context.client);
    const text = out.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    if (out.isError) return fail(200, ERR.internal, text || 'AGstudio could not read that');
    return fine({ contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }] });
  }
}

/** Creates the protocol handler: `handle(request)` answers one HTTP request. */
export function createMcpProtocol(backend: McpBackend, info: ServerInfo) {
  const protocol = new McpProtocol(backend, info);
  return { handle: (req: HttpIn): Promise<HttpOut> => protocol.handle(req) };
}

export const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
