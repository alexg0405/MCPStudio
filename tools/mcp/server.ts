import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin, ViteDevServer, WebSocketClient } from 'vite';
import {
  BRIDGE_EVENTS,
  type BridgeHello,
  type BridgeResult,
  type McpInfo,
  type ResourceDef,
  type ToolDef,
} from '../../src/app/mcp/types.ts';
import { BridgeError, McpBridge } from './bridge.ts';
import { checkAccess, isLocalHost, isLocalOrigin, isLoopbackAddress, RateLimit } from './guard.ts';
import { createMcpProtocol, errorResult, UnknownToolError, type HttpIn, type McpBackend } from './protocol.ts';
import { StatusTracker } from './status.ts';
import { TokenStore } from './token.ts';
import { cleanName, defaultExportsDir, saveUpload, UploadError, UploadTickets } from './uploads.ts';

/**
 * MCP for AGstudio: any AI app that speaks the Model Context Protocol (Claude Code, Claude Desktop…)
 * can read and change the open project, play it and render it, with the same tools the Studio chat uses.
 *
 *   POST /mcp                      JSON-RPC 2.0 (tools/mcp/protocol.ts); needs the access token
 *   GET  /api/mcp/info             the token, paths and who is connected (the app's Settings; same origin only)
 *   POST /api/mcp/token            a new token (same origin only)
 *   POST /api/mcp/upload/<ticket>  where the page sends a rendered export (valid only during that call)
 *
 * The project lives in the browser tab, so every tool call is relayed to it over Vite's HMR WebSocket
 * (tools/mcp/bridge.ts, answered by src/app/mcp). Dev server only: a production preview has no such channel.
 */
const MAX_BODY = 8 * 1024 * 1024;
/** Tools that render audio or wait for follow-up work get longer than a plain read. */
const SLOW = new Set(['apply_actions', 'analyze_mix', 'render_preview', 'export_audio', 'run_command']);

export interface McpServerOptions {
  /** The AGstudio folder (the token lives in `<root>/.agstudio/mcp-token`). */
  root: string;
  tokenFile?: string;
  exportsDir?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new UploadError('Request too large.', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('cache-control', 'no-store');
  if (body === undefined) return void res.end();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

const plain = (res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) => {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(`${message}\n`);
};

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** The app's own page (same origin, our header) on this computer: what the management endpoints allow. */
function fromOwnPage(req: IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress) || !isLocalHost(header(req, 'host'))) return false;
  if (header(req, 'x-agstudio') !== '1') return false;
  const origin = header(req, 'origin');
  return origin === undefined || (isLocalOrigin(origin) && new URL(origin).host === header(req, 'host'));
}

interface Defs {
  TOOL_DEFS: readonly ToolDef[];
  RESOURCE_DEFS: readonly ResourceDef[];
  SERVER_INSTRUCTIONS: string;
}

export function mcpServer(options: McpServerOptions): Plugin {
  // AGSTUDIO_MCP_TOKEN_FILE and AGSTUDIO_EXPORTS_DIR move the token and the exports (the tests use them).
  const tokens = new TokenStore(
    options.tokenFile ?? process.env.AGSTUDIO_MCP_TOKEN_FILE ?? join(options.root, '.agstudio', 'mcp-token'),
  );
  const exportsDir = options.exportsDir ?? process.env.AGSTUDIO_EXPORTS_DIR ?? defaultExportsDir();
  const status = new StatusTracker();
  const uploads = new UploadTickets();
  const limit = new RateLimit();

  return {
    name: 'ag:mcp-server',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      const url = () => {
        const addr = server.httpServer?.address();
        return `http://localhost:${addr && typeof addr === 'object' ? addr.port : (server.config.server.port ?? 5390)}`;
      };
      const bridge = new McpBridge({ openHint: () => `Open AGstudio in the browser first: ${url()}` });

      // ---- the tabs
      const socketOf = (client: WebSocketClient) => ({
        send: (event: string, data: unknown) => client.send(event, data),
        isOpen: () => client.socket.readyState === 1 && server.ws.clients.has(client),
      });
      server.ws.on(BRIDGE_EVENTS.hello, (data: BridgeHello, client) => {
        if (typeof data?.tab === 'string') bridge.hello(socketOf(client), data);
      });
      server.ws.on(BRIDGE_EVENTS.bye, (data: { tab?: string }) => {
        if (typeof data?.tab === 'string') bridge.bye(data.tab);
      });
      server.ws.on(BRIDGE_EVENTS.ack, (data: { id?: string }) => {
        if (typeof data?.id === 'string') bridge.ack(data.id);
      });
      server.ws.on(BRIDGE_EVENTS.result, (data: BridgeResult) => {
        if (typeof data?.id === 'string') bridge.result(data);
      });

      // ---- status pushed to the Settings window (at most twice a second)
      let timer: ReturnType<typeof setTimeout> | undefined;
      const push = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          status.tabs = bridge.open().length;
          server.ws.send({ type: 'custom', event: BRIDGE_EVENTS.status, data: status.snapshot() });
        }, 500);
      };
      status.onChange(push);
      bridge.onChange(push);
      server.httpServer?.once('close', () => {
        clearTimeout(timer);
        bridge.dispose();
      });

      // ---- what the tools are (read from the app's own module, so it is always current)
      const defs = async (): Promise<Defs> => (await server.ssrLoadModule('/src/app/mcp/defs.ts')) as unknown as Defs;

      const backend: McpBackend = {
        tools: async () => (await defs()).TOOL_DEFS,
        resources: async () => (await defs()).RESOURCE_DEFS,
        instructions: async () => (await defs()).SERVER_INSTRUCTIONS,
        onClient: (client) => status.touch(client),
        async call(name, args, client) {
          if (!(await defs()).TOOL_DEFS.some((t) => t.name === name)) throw new UnknownToolError(name);
          status.touch(client, true);
          const ticket = name === 'export_audio' ? uploads.issue() : undefined;
          try {
            return await bridge.call(name, args, { client, ticket }, SLOW.has(name) ? 15 * 60_000 : 60_000);
          } catch (e) {
            if (e instanceof BridgeError) return errorResult(e.message);
            throw e;
          } finally {
            uploads.revoke(ticket);
          }
        },
      };
      const protocol = createMcpProtocol(backend, { name: 'agstudio', title: 'AGstudio', version: '0.1.0' });

      // ---- POST /mcp
      server.middlewares.use('/mcp', (req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (path !== '' && path !== '/') return next();
        void (async () => {
          const denied = checkAccess(
            {
              remoteAddress: req.socket.remoteAddress,
              host: header(req, 'host'),
              origin: header(req, 'origin'),
              authorization: header(req, 'authorization'),
              url: req.url ?? '',
            },
            tokens.get(),
          );
          if (denied)
            return plain(res, denied.status, denied.message, denied.challenge ? { 'www-authenticate': denied.challenge } : {});
          if (req.method === 'POST' && !limit.take()) return plain(res, 429, 'Too many requests: slow down.', { 'retry-after': '5' });
          try {
            const input: HttpIn = {
              method: req.method ?? 'GET',
              headers: Object.fromEntries(
                Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]),
              ),
              body: req.method === 'POST' ? await readBody(req) : '',
            };
            const out = await protocol.handle(input);
            send(res, out.status, out.body, out.headers);
          } catch (e) {
            if (e instanceof UploadError) return plain(res, e.status, e.message);
            console.error('[agstudio] MCP request failed', e);
            plain(res, 500, 'AGstudio could not handle that request.');
          }
        })();
      });

      // An app that was refused may look for OAuth: say plainly that there is none (the dev server's page
      // fallback would answer with HTML, which reads as a broken server).
      server.middlewares.use('/.well-known', (req, res, next) => {
        if (!/^\/oauth-/.test(req.url ?? '')) return next();
        plain(res, 404, 'AGstudio has no OAuth: use the access token (Authorization: Bearer …).');
      });

      // ---- the app's own endpoints
      server.middlewares.use('/api/mcp', (req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        void (async () => {
          if (path === '/info' && req.method === 'GET') {
            if (!fromOwnPage(req)) return plain(res, 403, 'Only AGstudio itself may use this endpoint.');
            status.tabs = bridge.open().length;
            const info: McpInfo = { token: tokens.get(), root: options.root.replace(/\/$/, ''), exportsDir, status: status.snapshot() };
            return send(res, 200, info);
          }
          if (path === '/token' && req.method === 'POST') {
            if (!fromOwnPage(req)) return plain(res, 403, 'Only AGstudio itself may use this endpoint.');
            return send(res, 200, { token: tokens.regenerate() });
          }
          const m = /^\/upload\/([A-Za-z0-9_-]{16,64})$/.exec(path);
          if (m && req.method === 'POST') {
            if (!fromOwnPage(req)) return plain(res, 403, 'Only AGstudio itself may use this endpoint.');
            if (!uploads.valid(m[1]!)) return plain(res, 403, 'This upload is not expected (or its export already ended).');
            try {
              const decode = (h: string) => {
                const v = header(req, h);
                return v === undefined ? undefined : decodeURIComponent(v);
              };
              const folder = decode('x-folder');
              const file = await saveUpload(exportsDir, req, decode('x-filename') ?? 'export.wav', folder);
              return send(res, 200, { path: file, name: cleanName(file, 'export') });
            } catch (e) {
              if (e instanceof UploadError) return plain(res, e.status, e.message);
              console.error('[agstudio] MCP upload failed', e);
              return plain(res, 500, 'Could not write the file.');
            }
          }
          next();
        })();
      });
    },
  };
}
