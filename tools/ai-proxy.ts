import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/**
 * The beat assistant's line to Claude. The dev and preview servers forward Messages API requests
 * with the key from ANTHROPIC_API_KEY (put it in `.env.local`), so the key never reaches the page.
 *
 *   GET  /api/ai/status   → { configured: boolean }
 *   POST /api/ai/messages → Anthropic `POST /v1/messages` (Claude models only, capped tokens)
 *
 * Only same-origin requests carrying the `x-agstudio` header are served: a cross-origin page can't
 * send that header without a CORS preflight, which this endpoint never approves.
 */
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TOKENS = 16000;
const TIMEOUT_MS = 180_000;
const MODEL = /^claude-[a-z0-9.-]{1,64}$/;
const FORWARDED = ['model', 'max_tokens', 'system', 'messages', 'tools', 'tool_choice', 'temperature'] as const;

type Next = (err?: unknown) => void;

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
        reject(new Error('Request too large.'));
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

export function aiProxy(getKey: () => string | undefined): Plugin {
  const handle = async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/status' && req.method === 'GET') {
      send(res, 200, { configured: !!getKey() });
      return;
    }
    if (path !== '/messages') return next();
    if (req.method !== 'POST') return fail(res, 405, 'invalid_request_error', 'Use POST.');
    if (req.headers['x-agstudio'] !== '1' || !sameOrigin(req))
      return fail(res, 403, 'permission_error', 'Only AGstudio itself may use this endpoint.');
    const key = getKey();
    if (!key)
      return fail(
        res,
        503,
        'not_configured',
        'No Claude API key: add ANTHROPIC_API_KEY=… to .env.local in the project folder (no restart needed).',
      );
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      return fail(res, 400, 'invalid_request_error', 'The request body is not valid JSON.');
    }
    if (typeof body.model !== 'string' || !MODEL.test(body.model))
      return fail(res, 400, 'invalid_request_error', 'Unknown model.');
    const forward: Record<string, unknown> = {};
    for (const k of FORWARDED) if (body[k] !== undefined) forward[k] = body[k];
    forward.max_tokens = Math.min(MAX_TOKENS, Math.max(1, Number(body.max_tokens) || 4096));
    try {
      const upstream = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(forward),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      res.statusCode = upstream.status;
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(await upstream.text());
    } catch (e) {
      const timeout = e instanceof Error && e.name === 'TimeoutError';
      fail(
        res,
        timeout ? 504 : 502,
        'api_error',
        timeout ? 'Claude took too long to answer.' : "Couldn't reach Claude.",
      );
    }
  };
  type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;
  const use = (server: { middlewares: { use(path: string, fn: Middleware): unknown } }) => {
    server.middlewares.use('/api/ai', (req, res, next) => void handle(req, res, next));
  };
  return {
    name: 'ag:ai-proxy',
    configureServer: use,
    configurePreviewServer: use,
  };
}
