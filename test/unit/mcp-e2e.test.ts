/// <reference types="node" />
// The page's debug handle (window.__ag) and JSON-RPC answers are untyped on purpose here.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * End to end: the real dev server (the project's vite.config.ts, on a free port) and the real app in
 * headless Chrome, with an AI app's JSON-RPC over HTTP in between. Builds a beat through `apply_actions`,
 * reads it back, undoes it, renders a preview, exports a file, and tries the doors that must stay shut.
 */
let dir: string;
let vite: ViteDevServer;
let browser: Browser | null = null;
let page: Page;
let base = '';
let token = '';
let skipReason = '';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

interface Rpc {
  result?: Record<string, unknown> & { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; structuredContent?: Record<string, any>; isError?: boolean };
  error?: { code: number; message: string };
}

const CLIENT = { name: 'claude-code', version: '2.0.0' };
let nextId = 1;

/** One JSON-RPC call as the 2025-06-18 era does it (after `initialize`). */
async function rpc(method: string, params: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Rpc }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Rpc };
}

/** A tool call under the 2026-07-28 rules: per-request _meta and mirrored headers, no handshake. */
async function tool(name: string, args: Record<string, unknown> = {}) {
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': CLIENT, 'io.modelcontextprotocol/clientCapabilities': {} };
  const { status, body } = await rpc(
    'tools/call',
    { name, arguments: args, _meta: meta },
    { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name },
  );
  expect(status, JSON.stringify(body)).toBe(200);
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result!;
}
const textOf = (r: { content?: { type: string; text?: string }[] }) => (r.content ?? []).map((c) => c.text ?? '').join('\n');

/** A raw request with headers fetch() won't let us set (Host). */
function raw(path: string, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ag-mcp-e2e-'));
  process.env.AGSTUDIO_MCP_TOKEN_FILE = join(dir, 'token');
  process.env.AGSTUDIO_EXPORTS_DIR = join(dir, 'exports');
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  } catch (e) {
    skipReason = `Chrome is not available: ${e instanceof Error ? e.message.split('\n')[0] : e}`;
    return;
  }
  const port = await freePort();
  vite = await createServer({
    configFile: join(process.cwd(), 'vite.config.ts'),
    cacheDir: join(dir, 'vite-cache'),
    logLevel: 'error',
    server: { port, strictPort: true, host: '127.0.0.1' },
  });
  await vite.listen();
  base = `http://localhost:${port}`;
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => '__ag' in window, undefined, { timeout: 120_000 });
  // The tab says hello over the HMR socket: wait for the dev server to know it.
  token = (await readFile(join(dir, 'token'), 'utf8').catch(() => '')).trim();
  await page.waitForFunction(async () => (await fetch('/api/mcp/info', { headers: { 'x-agstudio': '1' } })).json().then((i: { status: { tabs: number } }) => i.status.tabs >= 1), undefined, { timeout: 60_000, polling: 500 });
  token = (await readFile(join(dir, 'token'), 'utf8')).trim();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await vite?.close();
  delete process.env.AGSTUDIO_MCP_TOKEN_FILE;
  delete process.env.AGSTUDIO_EXPORTS_DIR;
  await rm(dir, { recursive: true, force: true });
}, 60_000);

const live = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it(name, async (ctx) => {
    if (skipReason) return ctx.skip();
    await fn();
  }, timeout);

describe('MCP end to end (dev server + app in Chrome)', () => {
  live('turns away requests without the token, from other hosts and from other sites', async () => {
    const noToken = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(noToken.status).toBe(401);
    expect(await noToken.text()).toMatch(/access token/);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401);
    expect((await raw('/mcp', { host: 'evil.example', authorization: `Bearer ${token}` })).status).toBe(403);
    expect((await raw('/mcp', { host: `localhost:${new URL(base).port}`, origin: 'https://evil.example', authorization: `Bearer ${token}` })).status).toBe(403);
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
    // An app looking for OAuth is told there is none (not handed the page's HTML).
    const oauth = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(oauth.status).toBe(404);
    expect(await oauth.text()).toMatch(/no OAuth/);
    // The app's own endpoints are for the app only: they want its header.
    expect((await fetch(`${base}/api/mcp/info`)).status).toBe(403);
    expect((await fetch(`${base}/api/mcp/info`, { headers: { 'x-agstudio': '1', origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/api/mcp/upload/${'a'.repeat(30)}`, { method: 'POST', headers: { 'x-agstudio': '1' }, body: 'x' })).status).toBe(403);
  });

  live('the token also works as ?token= for clients that can only set a URL', async () => {
    const res = await fetch(`${base}/mcp?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect(res.status).toBe(200);
  });

  live('does the 2025 handshake and lists the tools with the Studio action schema', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: CLIENT });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'agstudio' }, capabilities: { tools: {} } });
    const list = await rpc('tools/list', {}, { 'mcp-protocol-version': '2025-06-18' });
    const tools = list.body.result!.tools as { name: string; inputSchema: { properties: { actions?: { items: { anyOf: unknown[] } } } } }[];
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['get_project', 'apply_actions', 'run_command', 'play', 'undo', 'analyze_mix', 'render_preview', 'export_audio']));
    expect(tools.find((t) => t.name === 'apply_actions')!.inputSchema.properties.actions!.items.anyOf.length).toBeGreaterThan(20);
  });

  live('reads the open project through the bridge', async () => {
    const r = await tool('get_project');
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toMatch(/^Song: \d+ BPM/);
    expect(textOf(await tool('transport_state'))).toMatch(/Stopped in/);
  });

  live('reads resources and keeps the long reads within what AI apps accept (about 25k tokens)', async () => {
    for (const name of ['get_guide', 'list_plugins', 'get_project', 'list_commands']) {
      const length = textOf(await tool(name)).length;
      console.info(`[mcp] ${name}: ${length} characters`);
      expect(length, name).toBeGreaterThan(200);
      expect(length, name).toBeLessThan(90_000);
    }
    const read = await rpc('resources/read', { uri: 'agstudio://project' }, { 'mcp-protocol-version': '2025-06-18' });
    expect((read.body.result!.contents as { text: string }[])[0]!.text).toMatch(/^Song: /);
    const list = await rpc('resources/list', {}, { 'mcp-protocol-version': '2025-06-18' });
    expect((list.body.result!.resources as { uri: string }[]).map((r) => r.uri)).toEqual(['agstudio://project', 'agstudio://commands', 'agstudio://plugins', 'agstudio://guide']);
  });

  live('applies a beat as one undo step, shows it in Studio, reads it back, and undoes it', async () => {
    const before = await page.evaluate(() => (window as any).__ag.history.steps().done.length as number);
    const r = await tool('apply_actions', {
      summary: 'Made a four-on-the-floor kick pattern',
      actions: [
        {
          op: 'beat',
          title: 'MCP kick',
          bars: 1,
          bpm: 124,
          tracks: [
            { name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 4 }, { step: 8 }, { step: 12 }] },
            { name: 'Hat', sound: 'hat', notes: [{ step: 2 }, { step: 6 }, { step: 10 }, { step: 14 }] },
          ],
        },
      ],
    });
    expect(r.isError, textOf(r)).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ applied: true, history_label: 'Claude Code: Made a four-on-the-floor kick pattern' });

    const state = await page.evaluate(() => {
      const ag = (window as any).__ag;
      return {
        steps: ag.history.steps().done.map((d: { label: string }) => d.label) as string[],
        bpm: ag.doc.getState().project.transport.bpm as number,
        chat: ag.assistant.store.getState().messages.map((m: { text: string; detail?: string; undo?: number }) => ({ text: m.text, detail: m.detail, undo: m.undo })),
      };
    });
    expect(state.steps).toHaveLength(before + 1);
    expect(state.steps.at(-1)).toBe('Claude Code: Made a four-on-the-floor kick pattern');
    expect(state.bpm).toBe(124);
    expect(state.chat.at(-1)).toMatchObject({ text: 'Claude Code changed: Made a four-on-the-floor kick pattern', detail: 'over MCP' });
    expect(state.chat.at(-1)!.undo).toBeGreaterThan(0);

    const project = textOf(await tool('get_project'));
    expect(project).toContain('Song: 124 BPM');
    expect(project).toContain('MCP kick');
    const pattern = await tool('get_pattern_notes', { pattern: 'MCP kick', channel: 'Kick' });
    expect(pattern.isError, textOf(pattern)).toBeUndefined();
    expect(JSON.stringify(pattern.structuredContent)).toContain('Kick');

    const undone = await tool('undo');
    expect(textOf(undone)).toMatch(/Undid 1 step/);
    expect(await page.evaluate(() => (window as any).__ag.doc.getState().project.transport.bpm as number)).not.toBe(124);
    await tool('redo');
    expect(await page.evaluate(() => (window as any).__ag.doc.getState().project.transport.bpm as number)).toBe(124);
  });

  live('runs commands and asks the musician to click for file dialogs', async () => {
    const list = await tool('list_commands', { search: 'save' });
    expect((list.structuredContent!.commands as { id: string }[]).some((c) => c.id === 'file.save' || c.id === 'file.saveAs')).toBe(true);
    const ran = await tool('run_command', { id: 'view.mixer' });
    expect(textOf(ran)).toMatch(/^Ran /);
    const gesture = (list.structuredContent!.commands as { id: string; needs_musician_click?: boolean }[]).find((c) => c.needs_musician_click);
    if (gesture) {
      const waiting = await tool('run_command', { id: gesture.id });
      expect(waiting.structuredContent).toMatchObject({ waiting_for_click: true });
      expect(await page.evaluate(() => (window as any).__ag.mcp.store.getState().gestures.length as number)).toBeGreaterThan(0);
      await page.keyboard.press('Escape');
    }
  });

  live('plays, loops and stops', async () => {
    await tool('apply_actions', { summary: 'Put the beat in the song', actions: [{ op: 'place_pattern', pattern: 'MCP kick', bar: 1, times: 4 }] });
    await tool('set_loop', { from_bar: 1, to_bar: 2 });
    await tool('play');
    expect(await page.evaluate(() => (window as any).__ag.engine.playing as boolean)).toBe(true);
    expect((await tool('transport_state')).structuredContent).toMatchObject({ playing: true, mode: 'song', loop: { from_bar: 1, to_bar: 2 } });
    await tool('stop');
    expect(await page.evaluate(() => (window as any).__ag.engine.playing as boolean)).toBe(false);
  });

  live('listens to the mix and renders a preview as audio content', async () => {
    const mix = await tool('analyze_mix', { bars: { from_bar: 1, to_bar: 2 } });
    expect(mix.isError, textOf(mix)).toBeUndefined();
    expect(textOf(mix)).toMatch(/Listened to .*bars 1–2/);
    expect(textOf(mix)).toMatch(/LUFS/);

    const preview = await tool('render_preview', { bars: { from_bar: 1, to_bar: 2 } });
    expect(preview.isError, textOf(preview)).toBeUndefined();
    const audio = preview.content!.find((c) => c.type === 'audio')!;
    expect(audio.mimeType).toBe('audio/wav');
    const wav = Buffer.from(audio.data!, 'base64');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(32000);
    expect(wav.length).toBeGreaterThan(32000 * 2 * 2 * 1); // more than a second of 16-bit stereo
  });

  live('exports a file into the exports folder without a file dialog', async () => {
    const r = await tool('export_audio', { bars: { from_bar: 1, to_bar: 2 }, format: 'wav', file_name: 'MCP Demo' });
    expect(r.isError, textOf(r)).toBeUndefined();
    const file = (r.structuredContent!.files as string[])[0]!;
    expect(file).toBe(join(dir, 'exports', 'MCP Demo.wav'));
    const bytes = await readFile(file);
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(bytes.length).toBeGreaterThan(100_000);
    // The same name again does not overwrite it.
    const again = await tool('export_audio', { bars: { from_bar: 1, to_bar: 2 }, format: 'wav', file_name: 'MCP Demo' });
    expect((again.structuredContent!.files as string[])[0]).toBe(join(dir, 'exports', 'MCP Demo (2).wav'));
  });

  live('shows who is connected in Settings, and a new token locks the old one out', async () => {
    await page.evaluate(() => (window as any).__ag.commands.run('options.connectAi'));
    await page.getByText('Connect AI apps (MCP)', { exact: true }).first().waitFor({ timeout: 20_000 });
    await page.getByText(/^Connected: Claude Code · (no calls|\d+ calls?) in the last minute$/).waitFor({ timeout: 20_000 }).catch(async (e) => {
      throw new Error(`${e.message}\n${(await page.evaluate(() => document.body.innerText)).split('\n').filter((l) => /connect|AI app|token/i.test(l)).join('\n')}`);
    });
    const body = await page.evaluate(() => document.body.innerText);
    expect(body).toContain('claude mcp add --transport http agstudio');
    expect(body).toContain('Authorization: Bearer agmcp_');
    expect(body).not.toContain(token);
    expect(body).toContain('bin/agstudio-mcp');

    await page.evaluate(() => (window as any).__ag.mcp.regenerateToken());
    const fresh = (await readFile(join(dir, 'token'), 'utf8')).trim();
    expect(fresh).not.toBe(token);
    const old = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' });
    expect(old.status).toBe(401);
    token = fresh;
    expect((await rpc('ping', {})).status).toBe(200);
  });

  live('switching it off turns the apps away with a message, and on again lets them in', async () => {
    await page.evaluate(() => (window as any).__ag.prefs.getState().set({ mcpEnabled: false }));
    await page.waitForTimeout(400);
    const off = await tool('get_project');
    expect(off.isError).toBe(true);
    expect(textOf(off)).toMatch(/switched off connections from AI apps/);
    await page.evaluate(() => (window as any).__ag.prefs.getState().set({ mcpEnabled: true }));
    await page.waitForTimeout(400);
    expect((await tool('get_project')).isError).toBeUndefined();
  });

  live('says to open AGstudio when the tab is gone', async () => {
    await page.close();
    await new Promise((r) => setTimeout(r, 1500));
    const r = await tool('get_project');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`Open AGstudio in the browser first: ${base}`);
    // The tools are still listed (they come from the app's own module, not the tab).
    expect(((await rpc('tools/list', {}, { 'mcp-protocol-version': '2025-06-18' })).body.result!.tools as unknown[]).length).toBeGreaterThan(15);
  });
});
