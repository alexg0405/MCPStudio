import { describe, expect, it, vi, type Mock } from 'vitest';
import { createTestServices } from '../testing';
import { McpLink, type HotChannel } from './bridge';
import type { McpTools } from './tools';
import { BRIDGE_EVENTS, type BridgeCall, type BridgeResult } from './types';

/** The page's end of the MCP connection, with a stand-in for Vite's HMR channel and the dev server's endpoints. */
function setup(tools?: { call: Mock<McpTools['call']> }) {
  const s = createTestServices();
  const handlers = new Map<string, (data: never) => void>();
  const sent: { event: string; data: unknown }[] = [];
  const hot: HotChannel = {
    on: (event, cb) => void handlers.set(event, cb),
    send: (event, data) => void sent.push({ event, data }),
  };
  const info = { token: 'agmcp_' + 'x'.repeat(43), root: '/work/AGstudio', exportsDir: '/Users/me/Music/AGstudio', platform: 'darwin', status: { clients: [], callsLastMinute: 0, tabs: 1 } };
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === '/api/mcp/info') return new Response(JSON.stringify(info));
    if (String(url) === '/api/mcp/token' && init?.method === 'POST') return new Response(JSON.stringify({ token: 'agmcp_new' }));
    return new Response('no', { status: 404 });
  }) as unknown as typeof fetch;
  const fakeTools = tools ?? { call: vi.fn<McpTools['call']>(async () => ({ content: [{ type: 'text' as const, text: 'hi' }] })) };
  const link = new McpLink(s, { fetch: fetchImpl, tabId: 'tab-1', tools: { names: () => [], call: fakeTools.call } });
  const emit = (event: string, data: unknown) => handlers.get(event)?.(data as never);
  const results = () => sent.filter((m) => m.event === BRIDGE_EVENTS.result).map((m) => m.data as BridgeResult);
  const call = (over: Partial<BridgeCall> = {}): BridgeCall => ({ id: 'c1', tab: 'tab-1', name: 'get_project', args: {}, client: { name: 'claude-code' }, ...over });
  return { s, link, hot, sent, emit, results, call, fakeTools, fetchImpl };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the page bridge to the dev server', () => {
  it('does nothing without a dev server channel', () => {
    const { link } = setup();
    link.start(undefined);
    expect(link.store.getState().available).toBe(false);
  });

  it('says hello with its tab id, focus and whether MCP is on, and reads the token', async () => {
    const { link, hot, sent, s } = setup();
    link.start(hot);
    await settle();
    const hello = sent.find((m) => m.event === BRIDGE_EVENTS.hello)!.data as Record<string, unknown>;
    expect(hello).toMatchObject({ tab: 'tab-1', enabled: true, project: 'Untitled' });
    expect(link.store.getState()).toMatchObject({ available: true, token: expect.stringMatching(/^agmcp_/), exportsDir: '/Users/me/Music/AGstudio' });
    // Switching it off in Settings tells the server.
    s.prefs.getState().set({ mcpEnabled: false });
    const last = sent.filter((m) => m.event === BRIDGE_EVENTS.hello).at(-1)!.data as Record<string, unknown>;
    expect(last.enabled).toBe(false);
  });

  it('says hello again when the dev server restarts and the socket reconnects', async () => {
    const { link, hot, sent, emit } = setup();
    link.start(hot);
    const n = sent.filter((m) => m.event === BRIDGE_EVENTS.hello).length;
    emit('vite:ws:connect', undefined);
    expect(sent.filter((m) => m.event === BRIDGE_EVENTS.hello).length).toBe(n + 1);
  });

  it('acknowledges a call at once, runs the tool and sends the result back', async () => {
    const { link, hot, sent, emit, results, call, fakeTools } = setup();
    link.start(hot);
    emit(BRIDGE_EVENTS.call, call({ args: { a: 1 }, ticket: 'tk' }));
    expect(sent.some((m) => m.event === BRIDGE_EVENTS.ack && (m.data as { id: string }).id === 'c1')).toBe(true);
    await settle();
    expect(fakeTools.call).toHaveBeenCalledWith('get_project', { a: 1 }, { client: { name: 'claude-code' }, ticket: 'tk' });
    expect(results()).toEqual([{ id: 'c1', ok: true, result: { content: [{ type: 'text', text: 'hi' }] } }]);
  });

  it('ignores a call meant for another tab', async () => {
    const { link, hot, sent, emit, results, call, fakeTools } = setup();
    link.start(hot);
    emit(BRIDGE_EVENTS.call, call({ tab: 'someone-else' }));
    await settle();
    expect(fakeTools.call).not.toHaveBeenCalled();
    expect(sent.some((m) => m.event === BRIDGE_EVENTS.ack)).toBe(false);
    expect(results()).toEqual([]);
  });

  it('refuses calls while MCP is switched off', async () => {
    const { link, hot, emit, results, call, fakeTools, s } = setup();
    link.start(hot);
    s.prefs.getState().set({ mcpEnabled: false });
    emit(BRIDGE_EVENTS.call, call());
    await settle();
    expect(fakeTools.call).not.toHaveBeenCalled();
    expect(results()[0]).toMatchObject({ id: 'c1', ok: false, error: expect.stringContaining('switched off') });
  });

  it('turns a crashing tool into an error result', async () => {
    const t = { call: vi.fn<McpTools['call']>(async () => Promise.reject(new Error('kaboom'))) };
    const { link, hot, emit, results, call } = setup(t);
    link.start(hot);
    emit(BRIDGE_EVENTS.call, call());
    await settle();
    expect(results()[0]).toEqual({ id: 'c1', ok: false, error: 'kaboom' });
  });

  it('tells the musician once when an app connects', async () => {
    const { link, hot, emit, call, s } = setup();
    link.start(hot);
    emit(BRIDGE_EVENTS.call, call({ id: 'a' }));
    emit(BRIDGE_EVENTS.call, call({ id: 'b' }));
    await settle();
    const toasts = s.session.getState().toasts.map((t) => t.text);
    expect(toasts).toEqual(['Claude Code is connected over MCP. What it changes shows in Studio, with Undo.']);
  });

  it('keeps the status the server pushes', () => {
    const { link, hot, emit } = setup();
    link.start(hot);
    emit(BRIDGE_EVENTS.status, { clients: [{ name: 'claude-code', lastSeen: 1, calls: 3 }], callsLastMinute: 3, tabs: 1 });
    expect(link.store.getState().status.callsLastMinute).toBe(3);
  });

  it('asks for a new token and holds the clicks AI apps wait for', async () => {
    const { link } = setup();
    await link.regenerateToken();
    expect(link.store.getState().token).toBe('agmcp_new');
    const t = createTestServices();
    const l2 = new McpLink(t, { tabId: 't2' });
    // A command that needs the musician's click is queued for a button.
    t.commands.register({ id: 'test.save', title: 'Save as…', hint: 'x', argsHint: 'none', gesture: true, run: () => {} });
    await (await l2.loadTools()).call('run_command', { id: 'test.save' }, { client: { name: 'claude-code' } });
    const [g] = l2.store.getState().gestures;
    expect(g).toMatchObject({ client: 'Claude Code', commandId: 'test.save' });
    expect(l2.resolveGesture(g!.id)).toMatchObject({ commandId: 'test.save' });
    expect(l2.store.getState().gestures).toEqual([]);
  });
});
