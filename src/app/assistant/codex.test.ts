import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestServices } from '../testing';
import { BeatAssistant } from './assistant';
import { ClaudeChat, fetchAiStatus } from './claude';
import { createAssistantCore } from './state';

/**
 * The ChatGPT (Codex) backend as the page sees it, against a fake /api/ai server: Auto's order, the model that is
 * sent, one conversation per backend (also across a reload) and the saved settings.
 */
const NO = { ok: false, reason: 'not set up' };
const OK = { ok: true };
type Status = { subscription: object; codex: object; api: object };

const answer = (title: string) => ({
  message: `Made ${title}.`,
  actions: [{ op: 'beat', title, bars: 1, tracks: [{ name: 'Kick', sound: 'kick', notes: [{ step: 0 }] }] }],
});

/** A fake server: the status it reports, and every chat request it got (a session id per backend, counting up). */
function fakeServer(status: Status) {
  const calls: Record<string, unknown>[] = [];
  let turns = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/status')) return new Response(JSON.stringify(status), { status: 200 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    turns++;
    return new Response(
      JSON.stringify({
        session: (body.session as string | null) ?? `${String(body.backend)}-thread-${turns}`,
        model: body.model,
        beat: answer(`Beat ${turns}`),
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const setup = (status: Status) => {
  const server = fakeServer(status);
  const s = createTestServices();
  const a = new BeatAssistant(s, { fetch: server.fetchImpl });
  a.set({ autoplay: false });
  return { s, a, ...server };
};

const storage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('Auto picks the way to reach an AI', () => {
  it.each([
    ['the Claude subscription first', { subscription: OK, codex: OK, api: OK }, 'subscription'],
    ['then ChatGPT through Codex', { subscription: NO, codex: OK, api: OK }, 'codex'],
    ['then a Claude API key', { subscription: NO, codex: NO, api: OK }, 'api'],
  ])('%s', async (_name, status, backend) => {
    const { a, calls } = setup(status);
    await a.send('four on the floor');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ backend });
  });

  it('and the offline generator when none is set up', async () => {
    const { a, calls } = setup({ subscription: NO, codex: NO, api: NO });
    await a.send('four on the floor');
    expect(calls).toHaveLength(0);
    expect(a.store.getState().messages.at(-1)).toMatchObject({ offline: true });
  });

  it('reads the codex status from the server', async () => {
    const { a } = setup({ subscription: NO, codex: { ok: false, reason: 'Codex is not signed in' }, api: NO });
    expect((await a.checkAi()).codex).toEqual({ ok: false, reason: 'Codex is not signed in' });
    expect(a.store.getState().status?.codex.reason).toBe('Codex is not signed in');
  });
});

describe('the ChatGPT backend', () => {
  it('asks Codex with its own model (empty = Codex default) and continues the thread', async () => {
    const { a, calls } = setup({ subscription: NO, codex: OK, api: NO });
    await a.send('trap beat');
    expect(calls[0]).toMatchObject({ backend: 'codex', model: '', session: null });
    // The catalog index is in the system prompt; the turn's text carries no catalog.
    expect(String(calls[0]!.system)).toContain('Catalog index v');
    expect(String(calls[0]!.text)).not.toContain('<plugins>');
    await a.send('busier hats');
    expect(calls[1]).toMatchObject({ backend: 'codex', model: '', session: 'codex-thread-1' });
    // the follow-up has nothing new to tell the thread about the catalog
    expect(String(calls[1]!.text)).not.toContain('<catalog-changes>');
    a.set({ codexModel: 'gpt-5.5' });
    await a.send('more 808');
    expect(calls[2]).toMatchObject({ backend: 'codex', model: 'gpt-5.5' });
  });

  it('keeps the Claude model for the Claude backends', async () => {
    const { a, calls } = setup({ subscription: OK, codex: OK, api: NO });
    a.set({ codexModel: 'gpt-5.5', model: 'claude-sonnet-5-5' });
    await a.send('trap beat');
    expect(calls[0]).toMatchObject({ backend: 'subscription', model: 'claude-sonnet-5-5' });
  });

  it('shows what the server says when a chosen backend fails', async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith('/status')
        ? new Response(JSON.stringify({ subscription: NO, codex: NO, api: NO }), { status: 200 })
        : new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Your ChatGPT plan is out of usage.' } }), {
            status: 429,
          })) as typeof fetch;
    const a = new BeatAssistant(createTestServices(), { fetch: fetchImpl });
    a.set({ backend: 'codex' });
    await a.send('trap beat');
    expect(a.store.getState().messages.at(-1)).toMatchObject({ error: true, text: 'Your ChatGPT plan is out of usage.' });
  });
});

describe('one conversation per backend', () => {
  it('switching backend starts a new conversation there, and switching back continues the old one', async () => {
    const { a, calls } = setup({ subscription: OK, codex: OK, api: OK });
    a.set({ backend: 'subscription' });
    await a.send('trap beat');
    a.set({ backend: 'codex' });
    await a.send('make it darker');
    a.set({ backend: 'subscription' });
    await a.send('busier hats');
    expect(calls.map((c) => [c.backend, c.session])).toEqual([
      ['subscription', null],
      ['codex', null], // not the Claude session id
      ['subscription', 'subscription-thread-1'],
    ]);
    // every thread starts from the same system prompt (the catalog index is in it); a continued one is told of no change
    expect(calls[1]!.system).toBe(calls[0]!.system);
    expect(String(calls[2]!.text)).not.toContain('<catalog-changes>');
  });

  it('New chat forgets every conversation', async () => {
    const { a, calls } = setup({ subscription: OK, codex: OK, api: OK });
    a.set({ backend: 'codex' });
    await a.send('trap beat');
    a.newBeat();
    await a.send('boom bap');
    expect(calls[1]).toMatchObject({ session: null });
    expect(calls[1]!.system).toBe(calls[0]!.system);
  });

  it('a reload keeps them', async () => {
    const session = storage();
    vi.stubGlobal('sessionStorage', session);
    const first = setup({ subscription: OK, codex: OK, api: OK });
    first.a.set({ backend: 'codex' });
    await first.a.send('trap beat');
    first.a.saveTab();
    const second = setup({ subscription: OK, codex: OK, api: OK });
    second.a.set({ backend: 'codex' });
    await second.a.send('busier');
    expect(second.calls[0]).toMatchObject({ backend: 'codex', session: 'codex-thread-1' });
    // the saved index version still matches: the thread is not told of a change
    expect(String(second.calls[0]!.text)).not.toContain('<catalog-changes>');
  });
});

describe('ClaudeChat sessions', () => {
  const read = (raw: unknown) => ({ value: raw });
  const turn = (chat: ClaudeChat, backend: 'subscription' | 'codex') =>
    chat.ask({ system: 's', schema: {}, text: 't', model: 'm', backend, read });

  it('keeps a session id per backend and hands them over for saving and restoring', async () => {
    const sent: { backend: string; session: string | null }[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { backend: string; session: string | null };
      sent.push({ backend: body.backend, session: body.session });
      return new Response(JSON.stringify({ session: body.session ?? `${body.backend}-1`, beat: {} }), { status: 200 });
    }) as typeof fetch;
    const chat = new ClaudeChat(fetchImpl);
    await turn(chat, 'subscription');
    await turn(chat, 'codex');
    await turn(chat, 'codex');
    expect(sent).toEqual([
      { backend: 'subscription', session: null },
      { backend: 'codex', session: null },
      { backend: 'codex', session: 'codex-1' },
    ]);
    expect(chat.sessions).toEqual({ subscription: 'subscription-1', codex: 'codex-1' });
    expect(chat.hasHistoryFor('codex')).toBe(true);
    expect(chat.hasHistoryFor('api')).toBe(false);
    const other = new ClaudeChat(fetchImpl);
    other.sessions = { codex: 'old-thread', api: 5, bogus: 'x' } as never;
    expect(other.sessions).toEqual({ codex: 'old-thread' });
    chat.reset();
    expect(chat.sessions).toEqual({});
  });

  it('treats an empty session id from the server as none', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ session: '', beat: {} }), { status: 200 })) as typeof fetch;
    const chat = new ClaudeChat(fetchImpl);
    await turn(chat, 'codex');
    expect(chat.hasHistoryFor('codex')).toBe(false);
  });
});

describe('fetchAiStatus', () => {
  it('reads all three, and a missing entry (an older server) as unreachable', async () => {
    const status = await fetchAiStatus((async () =>
      new Response(JSON.stringify({ subscription: OK, api: NO }), { status: 200 })) as typeof fetch);
    expect(status.subscription).toEqual(OK);
    expect(status.api).toEqual(NO);
    expect(status.codex.ok).toBe(false);
    const down = await fetchAiStatus((async () => {
      throw new TypeError('x');
    }) as typeof fetch);
    expect([down.subscription, down.api, down.codex].every((v) => !v.ok)).toBe(true);
    expect(Object.keys(down).sort()).toEqual(['api', 'codex', 'lookups', 'subscription']);
  });
});

describe('saved settings', () => {
  const core = () => createAssistantCore(createTestServices().history).store;

  it('keeps the codex backend and model, and ignores values it does not know', () => {
    const local = storage();
    vi.stubGlobal('localStorage', local);
    expect(core().getState()).toMatchObject({ backend: 'auto', codexModel: '' });
    const store = core();
    store.setState({ backend: 'codex', codexModel: 'gpt-5.5' });
    expect(JSON.parse(local.getItem('agstudio:assistant:v1')!)).toMatchObject({ backend: 'codex', codexModel: 'gpt-5.5' });
    expect(core().getState()).toMatchObject({ backend: 'codex', codexModel: 'gpt-5.5' });
    local.setItem('agstudio:assistant:v1', JSON.stringify({ backend: 'gpt', codexModel: 'Not A Model!' }));
    expect(core().getState()).toMatchObject({ backend: 'auto', codexModel: '' });
  });
});
