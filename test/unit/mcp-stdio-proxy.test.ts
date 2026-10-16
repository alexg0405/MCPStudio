/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * bin/agstudio-mcp.mjs, the stdio helper for apps that start MCP servers as programs (Claude Desktop):
 * lines in, one POST each to the MCP endpoint, lines out. Run against a small stand-in HTTP server.
 */
const SCRIPT = fileURLToPath(new URL('../../bin/agstudio-mcp.mjs', import.meta.url));

let server: Server;
let port: number;
const seen: { headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ headers: req.headers, body });
      if (req.headers.authorization !== 'Bearer agmcp_test') {
        res.statusCode = 401;
        return void res.end('AGstudio needs its access token.\n');
      }
      if (body.id === undefined) {
        res.statusCode = 202;
        return void res.end();
      }
      res.setHeader('content-type', 'application/json');
      if (body.method === 'initialize') res.setHeader('mcp-session-id', 'sess-1');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'agstudio' } } : { echoed: body.method },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise((r) => server.close(r)));

/** Starts the helper, sends lines, returns what it printed. */
async function run(lines: unknown[], env: Record<string, string> = {}): Promise<{ out: Record<string, unknown>[]; err: string }> {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, AGSTUDIO_URL: `http://127.0.0.1:${port}`, AGSTUDIO_MCP_TOKEN: 'agmcp_test', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out: Record<string, unknown>[] = [];
  createInterface({ input: child.stdout }).on('line', (l) => out.push(JSON.parse(l) as Record<string, unknown>));
  let err = '';
  child.stderr.on('data', (d) => (err += String(d)));
  for (const l of lines) child.stdin.write(typeof l === 'string' ? `${l}\n` : `${JSON.stringify(l)}\n`);
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  return { out, err };
}

describe('bin/agstudio-mcp.mjs', () => {
  it('forwards requests, keeps the session and version, and stays quiet for notifications', async () => {
    seen.length = 0;
    const { out } = await run([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    ]);
    expect(out).toHaveLength(1);
    expect((out[0]!.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
    expect(seen[0]!.headers['mcp-session-id']).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBe('Bearer agmcp_test');
    expect(seen[0]!.headers.accept).toContain('text/event-stream');
  });

  it('sends the session id and protocol version after initialize', async () => {
    seen.length = 0;
    // Sequential: the proxy runs lines side by side, so wait for initialize before the next line.
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, AGSTUDIO_URL: `http://127.0.0.1:${port}`, AGSTUDIO_MCP_TOKEN: 'agmcp_test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    await rl.next();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    const second = JSON.parse((await rl.next()).value as string) as { id: number; result: { echoed: string } };
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    expect(second).toMatchObject({ id: 2, result: { echoed: 'tools/list' } });
    const last = seen.at(-1)!;
    expect(last.headers['mcp-session-id']).toBe('sess-1');
    expect(last.headers['mcp-protocol-version']).toBe('2025-06-18');
    expect(seen.map((s) => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });

  it('mirrors the method and name into headers for the 2026-07-28 era', async () => {
    seen.length = 0;
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    const { out } = await run([{ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_project', arguments: {}, _meta: meta } }]);
    expect(out[0]).toMatchObject({ id: 7 });
    expect(seen[0]!.headers['mcp-protocol-version']).toBe('2026-07-28');
    expect(seen[0]!.headers['mcp-method']).toBe('tools/call');
    expect(seen[0]!.headers['mcp-name']).toBe('get_project');
  });

  it('turns a refusal into a JSON-RPC error the app can show', async () => {
    const { out } = await run([{ jsonrpc: '2.0', id: 3, method: 'tools/list' }], { AGSTUDIO_MCP_TOKEN: 'wrong' });
    expect(out[0]).toMatchObject({ id: 3, error: { code: -32603, message: 'AGstudio answered 401: AGstudio needs its access token.' } });
  });

  it('says AGstudio is not running when nothing answers', async () => {
    const { out } = await run([{ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { jsonrpc: '2.0', method: 'notifications/initialized' }], {
      AGSTUDIO_URL: 'http://127.0.0.1:9',
    });
    expect(out).toHaveLength(1);
    expect((out[0]!.error as { message: string }).message).toMatch(/AGstudio isn't running at http:\/\/127\.0\.0\.1:9\. Start it with the "agstudio" command/);
  });

  it('reports bad input without dying', async () => {
    const { out } = await run(['{nope', '', { jsonrpc: '2.0', id: 5, method: 'ping' }]);
    expect(out[0]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(out[1]).toMatchObject({ id: 5 });
  });
});
