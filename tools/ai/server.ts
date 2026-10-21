import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { sharedTokenStore, tokenFilePath } from '../mcp/token.ts';
import { apiBackend } from './api-backend.ts';
import { codexBackend } from './codex-backend.ts';
import { LOOKUP_SCOPE } from './lookup.ts';
import { subscriptionBackend } from './subscription-backend.ts';
import {
  AiServerError,
  MAX_SYSTEM_CHARS,
  MAX_TEXT_CHARS,
  type Backend,
  type BackendId,
  type BeatRequest,
  type LookupAccess,
} from './types.ts';

/**
 * The AI studio's server side, on the dev and preview servers (the browser never holds a key):
 *
 *   GET  /api/ai/status → { subscription: BackendStatus, api: BackendStatus, codex: BackendStatus, lookups: { mcp: boolean } }
 *   POST /api/ai/chat   → BeatRequest → BeatReply, or { error: { type, message } } (also /api/ai/beat)
 *
 * Three ways to reach an AI: the musician's Claude subscription through their signed-in Claude Code
 * CLI, an API key from .env.local through the Anthropic SDK, or their ChatGPT plan through their signed-in
 * Codex CLI. Only same-origin requests carrying
 * the `x-agstudio` header are served (a cross-origin page can't send it without a preflight).
 */
const MAX_BODY_BYTES = 1024 * 1024;
const CLAUDE_MODEL = /^claude-[a-z0-9.-]{1,64}$/;
/** Codex model ids ("gpt-5.5", "gpt-5.5-codex"…); empty means Codex's own default. */
const CODEX_MODEL = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

type Next = (err?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

const fail = (res: ServerResponse, status: number, type: string, message: string) =>
  send(res, status, { type: 'error', error: { type, message } });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AiServerError('Request too large.', 'invalid_request_error', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function parseRequest(raw: string): BeatRequest {
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AiServerError('The request body is not valid JSON.', 'invalid_request_error', 400);
  }
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (b.backend !== 'subscription' && b.backend !== 'api' && b.backend !== 'codex')
    throw new AiServerError('Unknown backend.', 'invalid_request_error', 400);
  const modelOk =
    b.backend === 'codex'
      ? b.model === '' || (str(b.model, 80) && CODEX_MODEL.test(b.model as string))
      : str(b.model, 80) && CLAUDE_MODEL.test(b.model as string);
  if (!modelOk) throw new AiServerError('Unknown model.', 'invalid_request_error', 400);
  const tooLong = (v: unknown, max: number) => typeof v === 'string' && v.length > max;
  if (tooLong(b.system, MAX_SYSTEM_CHARS) || tooLong(b.text, MAX_TEXT_CHARS)) {
    const sizes = `system ${String(b.system).length}, text ${String(b.text).length} characters`;
    throw new AiServerError(`The request is too long for AGstudio's AI server (${sizes}).`, 'invalid_request_error', 413);
  }
  if (!str(b.system, MAX_SYSTEM_CHARS) || !str(b.text, MAX_TEXT_CHARS))
    throw new AiServerError('Missing prompt.', 'invalid_request_error', 400);
  if (typeof b.schema !== 'object' || b.schema === null || Array.isArray(b.schema))
    throw new AiServerError('Missing schema.', 'invalid_request_error', 400);
  const blocks = systemBlocksOf(b.systemBlocks, b.system as string);
  return {
    backend: b.backend,
    model: b.model as string,
    session: typeof b.session === 'string' && b.session.length <= 200 ? b.session : null,
    system: b.system as string,
    ...(blocks ? { systemBlocks: blocks } : {}),
    schema: b.schema as Record<string, unknown>,
    text: b.text as string,
    ...(b.readTools === true ? { readTools: true } : {}),
  };
}

/** The system prompt's blocks, when they are strings that add up to the system prompt (else the API backend sends one block). */
function systemBlocksOf(value: unknown, system: string): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === 'string')) return undefined;
  return value.join('\n\n') === system ? (value as string[]) : undefined;
}

/** The port this dev server listens on. */
function listeningPort(server: ViteDevServer): number | null {
  const address = server.httpServer?.address();
  if (address && typeof address === 'object') return address.port;
  return server.config.server.port ?? null;
}

/**
 * How a backend reaches the read tools during a turn: this dev server's read-only MCP endpoint, the helper that talks to it
 * over stdio, and the names of the read tools (read from the app, so a new read tool is there at once). Null when this server
 * is not listening or has no token file.
 */
async function lookupAccess(server: ViteDevServer, root: string): Promise<LookupAccess | null> {
  const port = listeningPort(server);
  if (port === null) return null;
  const tokenFile = tokenFilePath(root);
  // The same store the endpoint checks against: it makes the file when there is none, and a new token reaches both.
  sharedTokenStore(tokenFile).get();
  if (!existsSync(tokenFile)) return null;
  const defs = (await server.ssrLoadModule('/src/app/mcp/defs.ts')) as { LOOKUP_TOOL_NAMES: readonly string[] };
  return {
    url: `http://localhost:${port}/mcp?scope=${LOOKUP_SCOPE}`,
    tokenFile,
    command: process.execPath,
    args: [join(root, 'bin', 'agstudio-mcp.mjs')],
    tools: defs.LOOKUP_TOOL_NAMES,
  };
}

export interface AiServerOptions {
  /** The AGstudio folder: where the MCP access token (.agstudio/mcp-token) and the stdio helper (bin/agstudio-mcp.mjs) are. */
  root: string;
}

export function aiServer(env: () => Record<string, string | undefined>, options: AiServerOptions): Plugin {
  const backends: Record<BackendId, Backend> = {
    api: apiBackend(() => env().ANTHROPIC_API_KEY || undefined),
    subscription: subscriptionBackend(() => env().AGSTUDIO_CLAUDE_BIN || undefined),
    codex: codexBackend(() => env().AGSTUDIO_CODEX_BIN || undefined),
  };

  // The dev server, which has the MCP endpoint. A preview server has none, so its turns have no read tools.
  let devServer: ViteDevServer | null = null;

  const handle = async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/status' && req.method === 'GET') {
      const [subscription, api, codex] = await Promise.all([
        backends.subscription.status(),
        backends.api.status(),
        backends.codex.status(),
      ]);
      send(res, 200, { subscription, api, codex, lookups: { mcp: devServer !== null } });
      return;
    }
    if (path !== '/chat' && path !== '/beat') return next();
    if (req.method !== 'POST') return fail(res, 405, 'invalid_request_error', 'Use POST.');
    if (req.headers['x-agstudio'] !== '1' || !sameOrigin(req))
      return fail(res, 403, 'permission_error', 'Only AGstudio itself may use this endpoint.');
    const abort = new AbortController();
    // The page went away (or the musician pressed Stop): stop the AI call too.
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const request = parseRequest(await readBody(req));
      const lookup =
        request.readTools && devServer ? await lookupAccess(devServer, options.root).catch(() => null) : null;
      send(res, 200, await backends[request.backend].beat(request, abort.signal, lookup ?? undefined));
    } catch (e) {
      if (abort.signal.aborted) return;
      if (e instanceof AiServerError) return fail(res, e.status, e.type, e.message);
      console.error('[agstudio] beat assistant request failed', e);
      fail(res, 500, 'api_error', e instanceof Error ? e.message : String(e));
    }
  };

  const mount = (server: { middlewares: { use(path: string, fn: Middleware): unknown } }) => {
    server.middlewares.use('/api/ai', (req, res, next) => void handle(req, res, next));
  };
  return {
    name: 'ag:ai-server',
    configureServer(server) {
      devServer = server;
      mount(server);
    },
    configurePreviewServer: mount,
  };
}
