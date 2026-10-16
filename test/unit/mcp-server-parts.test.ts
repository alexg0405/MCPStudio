/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError, McpBridge, type TabSocket } from '../../tools/mcp/bridge.ts';
import { checkAccess, isLocalHost, isLocalOrigin, isLoopbackAddress, RateLimit, tokenOf, type Access } from '../../tools/mcp/guard.ts';
import { StatusTracker } from '../../tools/mcp/status.ts';
import { TokenStore } from '../../tools/mcp/token.ts';
import { cleanName, saveUpload, UploadError, UploadTickets } from '../../tools/mcp/uploads.ts';
import { BRIDGE_EVENTS, type BridgeCall } from '../../src/app/mcp/types.ts';

const TOKEN = 'agmcp_' + 'a'.repeat(43);
const ok: Access = {
  remoteAddress: '127.0.0.1',
  host: 'localhost:5390',
  origin: undefined,
  authorization: `Bearer ${TOKEN}`,
  url: '/',
};

describe('MCP access: this computer, this host, the token', () => {
  it('lets a local app with the token in', () => {
    expect(checkAccess(ok, TOKEN)).toBeNull();
    expect(checkAccess({ ...ok, authorization: undefined, url: `/?token=${TOKEN}` }, TOKEN)).toBeNull();
    expect(checkAccess({ ...ok, remoteAddress: '::1', host: '[::1]:5390' }, TOKEN)).toBeNull();
    expect(checkAccess({ ...ok, remoteAddress: '::ffff:127.0.0.1', host: '127.0.0.1:5390' }, TOKEN)).toBeNull();
    expect(checkAccess({ ...ok, origin: 'http://localhost:5390' }, TOKEN)).toBeNull();
  });

  it('answers 401 with a plain message when the token is missing or wrong', () => {
    for (const a of [
      { ...ok, authorization: undefined },
      { ...ok, authorization: 'Bearer nope' },
      { ...ok, authorization: `Basic ${TOKEN}` },
      { ...ok, authorization: undefined, url: '/?token=wrong' },
    ]) {
      const d = checkAccess(a, TOKEN);
      expect(d?.status).toBe(401);
      expect(d?.message).toMatch(/access token/);
      expect(d?.challenge).toMatch(/^Bearer/);
    }
  });

  it('answers 403 for a connection from another computer, even with the token', () => {
    for (const remoteAddress of ['192.168.1.20', '10.0.0.2', '::ffff:192.168.1.20', undefined, '8.8.8.8'])
      expect(checkAccess({ ...ok, remoteAddress }, TOKEN)?.status).toBe(403);
  });

  it('answers 403 for a Host that is not this computer (DNS rebinding)', () => {
    for (const host of ['evil.example', 'evil.example:5390', 'localhost.evil.example', '192.168.1.5:5390', undefined, '']) {
      const d = checkAccess({ ...ok, host }, TOKEN);
      expect(d?.status, String(host)).toBe(403);
    }
  });

  it('answers 403 for an Origin from another site, even with the token and a local Host', () => {
    for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null', 'file://', 'not a url', 'http://192.168.1.5:5390', 'chrome-extension://abc']) {
      const d = checkAccess({ ...ok, origin }, TOKEN);
      expect(d?.status, origin).toBe(403);
    }
  });

  it('checks the connection first, then Host, then Origin, then the token', () => {
    const bad = { remoteAddress: '8.8.8.8', host: 'evil', origin: 'https://evil', authorization: undefined, url: '/' };
    expect(checkAccess(bad, TOKEN)?.message).toMatch(/this computer/);
    expect(checkAccess({ ...bad, remoteAddress: '127.0.0.1' }, TOKEN)?.message).toMatch(/host name/);
    expect(checkAccess({ ...bad, remoteAddress: '127.0.0.1', host: 'localhost' }, TOKEN)?.message).toMatch(/other sites/);
    expect(checkAccess({ ...bad, remoteAddress: '127.0.0.1', host: 'localhost', origin: undefined }, TOKEN)?.status).toBe(401);
  });

  it('has small helpers that behave', () => {
    expect(isLoopbackAddress('127.8.9.1')).toBe(true);
    expect(isLoopbackAddress('1270.0.0.1')).toBe(false);
    expect(isLocalHost('LOCALHOST:80')).toBe(true);
    expect(isLocalHost('localhost:99999')).toBe(false);
    expect(isLocalOrigin(undefined)).toBe(true);
    expect(tokenOf({ authorization: 'bearer abc', url: '/' })).toBe('abc');
    expect(tokenOf({ authorization: undefined, url: '/mcp?x=1&token=t' })).toBe('t');
  });

  it('limits a flood of requests', () => {
    let t = 0;
    const limit = new RateLimit(3, 1000, () => t);
    expect([limit.take(), limit.take(), limit.take(), limit.take()]).toEqual([true, true, true, false]);
    t = 1001;
    expect(limit.take()).toBe(true);
  });
});

describe('MCP token', () => {
  let dir: string;
  beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), 'ag-token-'))));
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('is made once, kept in a private file and reused after a restart', async () => {
    const file = join(dir, '.agstudio', 'mcp-token');
    const a = new TokenStore(file).get();
    expect(a).toMatch(/^agmcp_[A-Za-z0-9_-]{43}$/);
    expect(new TokenStore(file).get()).toBe(a);
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect((await readFile(file, 'utf8')).trim()).toBe(a);
  });

  it('regenerates on request and replaces a damaged file', async () => {
    const file = join(dir, 'mcp-token');
    const store = new TokenStore(file);
    const a = store.get();
    const b = store.regenerate();
    expect(b).not.toBe(a);
    expect(new TokenStore(file).get()).toBe(b);
    await writeFile(file, 'garbage');
    const c = new TokenStore(file).get();
    expect(c).toMatch(/^agmcp_/);
    expect(c).not.toBe(b);
  });
});

describe('MCP uploads', () => {
  let dir: string;
  beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), 'ag-up-'))));
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const body = (s: string) => Readable.from([Buffer.from(s)]);

  it('writes audio into the folder and never over an existing file', async () => {
    const a = await saveUpload(dir, body('one'), 'Song.wav');
    const b = await saveUpload(dir, body('two'), 'Song.wav');
    expect(a).toBe(join(dir, 'Song.wav'));
    expect(b).toBe(join(dir, 'Song (2).wav'));
    expect(await readFile(a, 'utf8')).toBe('one');
    expect(await readFile(b, 'utf8')).toBe('two');
  });

  it('puts stems in one sub-folder and cleans names so nothing escapes', async () => {
    const stem = await saveUpload(dir, body('s'), 'Song - Drums.flac', 'Song (stems)');
    expect(stem).toBe(join(dir, 'Song (stems)', 'Song - Drums.flac'));
    const sneaky = await saveUpload(dir, body('x'), '../../etc/evil.wav', '../../outside');
    expect(sneaky.startsWith(dir)).toBe(true);
    expect(cleanName('..\\..\\a:b?.wav', 'x')).toBe('a_b_.wav');
    expect(cleanName('...', 'fallback')).toBe('fallback');
    expect(cleanName('.hidden.wav', 'x')).toBe('hidden.wav');
  });

  it('writes only audio files', async () => {
    for (const name of ['run.sh', 'a.html', 'noext', 'x.wav.exe'])
      await expect(saveUpload(dir, body('x'), name)).rejects.toThrow(UploadError);
  });

  it('knows its tickets only while an export runs', () => {
    const t = new UploadTickets();
    const id = t.issue();
    expect(t.valid(id)).toBe(true);
    expect(t.valid('guess')).toBe(false);
    t.revoke(id);
    expect(t.valid(id)).toBe(false);
  });
});

/** A browser tab as the bridge sees it. */
function tab(open = true) {
  const sent: { event: string; data: BridgeCall }[] = [];
  const socket: TabSocket & { open: boolean } = {
    open,
    send: (event, data) => sent.push({ event, data: data as BridgeCall }),
    isOpen() {
      return this.open;
    },
  };
  return { socket, sent };
}

describe('MCP bridge to the browser tab', () => {
  const make = () => new McpBridge({ openHint: () => 'Open AGstudio in the browser first: http://localhost:5390', ackTimeoutMs: 50 });
  const result = { content: [{ type: 'text' as const, text: 'done' }] };

  it('says to open AGstudio when no tab is connected', async () => {
    await expect(make().call('get_project', {})).rejects.toThrow('Open AGstudio in the browser first: http://localhost:5390');
  });

  it('relays a call to the tab and returns its answer', async () => {
    const b = make();
    const t = tab();
    b.hello(t.socket, { tab: 't1', focused: true, enabled: true });
    const p = b.call('get_project', { a: 1 }, { client: { name: 'claude-code' } });
    expect(t.sent).toHaveLength(1);
    const call = t.sent[0]!.data;
    expect(t.sent[0]!.event).toBe(BRIDGE_EVENTS.call);
    expect(call).toMatchObject({ tab: 't1', name: 'get_project', args: { a: 1 }, client: { name: 'claude-code' } });
    b.ack(call.id);
    b.result({ id: call.id, ok: true, result });
    await expect(p).resolves.toEqual(result);
  });

  it('turns a tool failure in the page into an error', async () => {
    const b = make();
    const t = tab();
    b.hello(t.socket, { tab: 't1', focused: true, enabled: true });
    const p = b.call('x', {});
    b.result({ id: t.sent[0]!.data.id, ok: false, error: 'it broke' });
    await expect(p).rejects.toThrow(new BridgeError('it broke'));
  });

  it('sends the call to the tab used most recently; the others never hear it', async () => {
    const b = make();
    const a = tab();
    const c = tab();
    b.hello(a.socket, { tab: 'a', focused: true, enabled: true });
    await new Promise((r) => setTimeout(r, 5));
    b.hello(c.socket, { tab: 'c', focused: true, enabled: true });
    void b.call('x', {}).catch(() => undefined);
    expect(c.sent).toHaveLength(1);
    expect(a.sent).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 5));
    b.hello(a.socket, { tab: 'a', focused: true, enabled: true });
    void b.call('y', {}).catch(() => undefined);
    expect(a.sent).toHaveLength(1);
  });

  it('a tab that merely reloads in the background does not steal the calls', async () => {
    const b = make();
    const a = tab();
    const c = tab();
    b.hello(a.socket, { tab: 'a', focused: true, enabled: true });
    await new Promise((r) => setTimeout(r, 5));
    b.hello(c.socket, { tab: 'c', focused: false, enabled: true });
    void b.call('x', {}).catch(() => undefined);
    expect(a.sent).toHaveLength(1);
    expect(c.sent).toHaveLength(0);
  });

  it('skips tabs whose connection is gone', async () => {
    const b = make();
    const gone = tab();
    const live = tab();
    b.hello(live.socket, { tab: 'live', focused: true, enabled: true });
    await new Promise((r) => setTimeout(r, 5));
    b.hello(gone.socket, { tab: 'gone', focused: true, enabled: true });
    gone.socket.open = false;
    void b.call('x', {}).catch(() => undefined);
    expect(live.sent).toHaveLength(1);
    expect(b.open().map((t) => t.tab)).toEqual(['live']);
  });

  it('fails right away when the musician switched MCP off', async () => {
    const b = make();
    const t = tab();
    b.hello(t.socket, { tab: 't', focused: true, enabled: false });
    await expect(b.call('x', {})).rejects.toThrow(/switched off/);
    expect(t.sent).toHaveLength(0);
  });

  it('tells a frozen tab (no ack) from a slow tool', async () => {
    const b = make();
    const frozen = tab();
    b.hello(frozen.socket, { tab: 'f', focused: true, enabled: true });
    await expect(b.call('x', {}, {}, 5000)).rejects.toThrow(/did not answer/);

    const slow = tab();
    const b2 = make();
    b2.hello(slow.socket, { tab: 's', focused: true, enabled: true });
    const p = b2.call('x', {}, {}, 5000);
    b2.ack(slow.sent[0]!.data.id);
    await new Promise((r) => setTimeout(r, 120));
    b2.result({ id: slow.sent[0]!.data.id, ok: true, result });
    await expect(p).resolves.toEqual(result);
  });

  it('gives up on a tool that never finishes', async () => {
    const b = make();
    const t = tab();
    b.hello(t.socket, { tab: 't', focused: true, enabled: true });
    const p = b.call('apply_actions', {}, {}, 80);
    b.ack(t.sent[0]!.data.id);
    await expect(p).rejects.toThrow(/taking longer than/);
  });

  it('fails the call when the tab closes while it works', async () => {
    vi.useFakeTimers();
    try {
      const b = make();
      const t = tab();
      b.hello(t.socket, { tab: 't', focused: true, enabled: true });
      const p = b.call('x', {}, {}, 600_000);
      const caught = p.catch((e: Error) => e.message);
      b.ack(t.sent[0]!.data.id);
      t.socket.open = false;
      await vi.advanceTimersByTimeAsync(1100);
      await expect(caught).resolves.toMatch(/tab was closed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes an export ticket along and forgets tabs that say goodbye', () => {
    const b = make();
    const t = tab();
    b.hello(t.socket, { tab: 't', focused: true, enabled: true });
    void b.call('export_audio', {}, { ticket: 'tk' }).catch(() => undefined);
    expect(t.sent[0]!.data.ticket).toBe('tk');
    b.bye('t');
    expect(b.open()).toEqual([]);
  });
});

describe('MCP status', () => {
  it('counts calls in the last minute and names who called', () => {
    let now = 1_000_000;
    const s = new StatusTracker(() => now);
    s.touch({ name: 'claude-code', version: '2.1' }, true);
    s.touch({ name: 'claude-code' }, true);
    now += 10;
    s.touch(undefined, false);
    expect(s.snapshot().callsLastMinute).toBe(2);
    expect(s.snapshot().clients.map((c) => c.name)).toEqual(['An AI app', 'claude-code']);
    expect(s.snapshot().clients[1]).toMatchObject({ version: '2.1', calls: 2 });
    now += 61_000;
    expect(s.snapshot().callsLastMinute).toBe(0);
    now += 600_000;
    expect(s.snapshot().clients).toEqual([]);
  });
});
