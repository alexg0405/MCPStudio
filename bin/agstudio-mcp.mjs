// AGstudio's MCP server over stdio, for apps that start MCP servers as programs (Claude Desktop).
//
// It reads JSON-RPC messages from stdin (one per line), forwards each to AGstudio's MCP endpoint
// (POST http://localhost:5390/mcp) and writes the answer to stdout. Node built-ins only.
//
//   AGSTUDIO_URL         where AGstudio runs (default http://localhost:5390)
//   AGSTUDIO_MCP_TOKEN   the access token; default: read from .agstudio/mcp-token next to this script's repo
//   AGSTUDIO_MCP_TOKEN_FILE  a file holding the token, read for every request, used when AGSTUDIO_MCP_TOKEN is not set
//                        (Studio's own AI backends use it, so no config file or command line ever holds the token)
//   AGSTUDIO_MCP_URL     the whole endpoint, e.g. http://localhost:5390/mcp?scope=lookup (the read-only face)
//
// Run `bin/agstudio-mcp` (the wrapper that finds Node), not this file, from a Claude Desktop config.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.env.AGSTUDIO_URL || 'http://localhost:5390').replace(/\/+$/, '');
const endpoint = process.env.AGSTUDIO_MCP_URL || `${base}/mcp`;
const V = 'io.modelcontextprotocol';

/** The token is read for every request, so a new one (Settings → Connect AI apps) works without a restart. */
function token() {
  if (process.env.AGSTUDIO_MCP_TOKEN) return process.env.AGSTUDIO_MCP_TOKEN.trim();
  try {
    return readFileSync(process.env.AGSTUDIO_MCP_TOKEN_FILE || join(root, '.agstudio', 'mcp-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

let session;
let version;
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const failure = (id, message, code = -32603) => out({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const isRequest = (m) => m && typeof m === 'object' && typeof m.method === 'string' && m.id !== undefined && m.id !== null;

async function forward(msg) {
  const meta = msg?.params?._meta;
  const asked = meta?.[`${V}/protocolVersion`];
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token()}`,
  };
  if (msg?.method !== 'initialize') {
    const v = asked ?? version;
    if (v) headers['mcp-protocol-version'] = v;
    if (session) headers['mcp-session-id'] = session;
  }
  // Streamable HTTP 2026-07-28 mirrors the method and name into headers.
  if (asked && typeof msg.method === 'string') {
    headers['mcp-method'] = msg.method;
    const name = msg.method === 'tools/call' ? msg.params?.name : msg.method === 'resources/read' ? msg.params?.uri : undefined;
    if (typeof name === 'string') headers['mcp-name'] = /^[\x20-\x7e]*$/.test(name) ? name : `=?base64?${Buffer.from(name).toString('base64')}?=`;
  }
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(msg) });
  } catch {
    if (isRequest(msg))
      failure(msg.id, `AGstudio isn't running at ${base}. Start it with the "agstudio" command (or npm run dev in the AGstudio folder), open it in Chrome, then try again.`);
    return;
  }
  if (res.status === 202) return;
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  if (!res.ok && !type.includes('json')) {
    if (isRequest(msg)) failure(msg.id, `AGstudio answered ${res.status}: ${body.trim()}`);
    return;
  }
  if (msg?.method === 'initialize' && res.ok) {
    session = res.headers.get('mcp-session-id') || session;
    try {
      version = JSON.parse(body).result?.protocolVersion ?? version;
    } catch {
      /* the client sees the same body */
    }
  }
  if (type.includes('event-stream')) {
    for (const line of body.split(/\r?\n/)) if (line.startsWith('data:')) process.stdout.write(`${line.slice(5).trim()}\n`);
  } else if (body.trim()) {
    // A batch answer is an array: one line per message is also valid for stdio clients.
    try {
      const parsed = JSON.parse(body);
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) out(m);
    } catch {
      if (isRequest(msg)) failure(msg.id, `AGstudio sent something that is not JSON (${res.status}).`);
    }
  }
}

const pending = new Set();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return failure(null, 'Not valid JSON.', -32700);
  }
  // Requests run side by side: a long tool call must not hold up the next one.
  const p = forward(msg).catch((e) => process.stderr.write(`agstudio-mcp: ${e?.message ?? e}\n`));
  pending.add(p);
  p.finally(() => pending.delete(p));
});
lines.on('close', () => void Promise.all([...pending]).then(() => process.exit(0)));
