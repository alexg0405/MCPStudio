import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { apiBackend } from './api-backend.ts';
import { subscriptionBackend } from './subscription-backend.ts';
import { AiServerError, type Backend, type BackendId, type BeatRequest } from './types.ts';

/**
 * The AI studio's server side, on the dev and preview servers (the browser never holds a key):
 *
 *   GET  /api/ai/status → { subscription: BackendStatus, api: BackendStatus }
 *   POST /api/ai/chat   → BeatRequest → BeatReply, or { error: { type, message } } (also /api/ai/beat)
 *
 * Two ways to reach Claude: the musician's Claude subscription through their signed-in Claude Code
 * CLI, or an API key from .env.local through the Anthropic SDK. Only same-origin requests carrying
 * the `x-agstudio` header are served (a cross-origin page can't send it without a preflight).
 */
const MAX_BODY_BYTES = 1024 * 1024;
const MODEL = /^claude-[a-z0-9.-]{1,64}$/;

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

function parseRequest(raw: string): BeatRequest {
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AiServerError('The request body is not valid JSON.', 'invalid_request_error', 400);
  }
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (b.backend !== 'subscription' && b.backend !== 'api')
    throw new AiServerError('Unknown backend.', 'invalid_request_error', 400);
  if (!str(b.model, 80) || !MODEL.test(b.model as string))
    throw new AiServerError('Unknown model.', 'invalid_request_error', 400);
  if (!str(b.system, 60_000) || !str(b.text, 100_000))
    throw new AiServerError('Missing prompt.', 'invalid_request_error', 400);
  if (typeof b.schema !== 'object' || b.schema === null || Array.isArray(b.schema))
    throw new AiServerError('Missing schema.', 'invalid_request_error', 400);
  return {
    backend: b.backend,
    model: b.model as string,
    session: typeof b.session === 'string' && b.session.length <= 200 ? b.session : null,
    system: b.system as string,
    schema: b.schema as Record<string, unknown>,
    text: b.text as string,
  };
}

export function aiServer(env: () => Record<string, string | undefined>): Plugin {
  const backends: Record<BackendId, Backend> = {
    api: apiBackend(() => env().ANTHROPIC_API_KEY || undefined),
    subscription: subscriptionBackend(() => env().AGSTUDIO_CLAUDE_BIN || undefined),
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/status' && req.method === 'GET') {
      const [subscription, api] = await Promise.all([backends.subscription.status(), backends.api.status()]);
      send(res, 200, { subscription, api });
      return;
    }
    if (path !== '/chat' && path !== '/beat') return next();
    if (req.method !== 'POST') return fail(res, 405, 'invalid_request_error', 'Use POST.');
    if (req.headers['x-agstudio'] !== '1' || !sameOrigin(req))
      return fail(res, 403, 'permission_error', 'Only AGstudio itself may use this endpoint.');
    const abort = new AbortController();
    // The page went away (or the musician pressed Stop): stop the Claude call too.
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const request = parseRequest(await readBody(req));
      send(res, 200, await backends[request.backend].beat(request, abort.signal));
    } catch (e) {
      if (abort.signal.aborted) return;
      if (e instanceof AiServerError) return fail(res, e.status, e.type, e.message);
      console.error('[agstudio] beat assistant request failed', e);
      fail(res, 500, 'api_error', e instanceof Error ? e.message : String(e));
    }
  };

  const use = (server: { middlewares: { use(path: string, fn: Middleware): unknown } }) => {
    server.middlewares.use('/api/ai', (req, res, next) => void handle(req, res, next));
  };
  return { name: 'ag:ai-server', configureServer: use, configurePreviewServer: use };
}
