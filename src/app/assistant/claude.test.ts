import { describe, expect, it } from 'vitest';
import { setStep } from '@core/ops/notes';
import { createTestServices } from '../testing';
import { ClaudeBeatChat, fetchAiStatus, type AiError } from './claude';
import { describeProject } from './context';

const BEAT = {
  title: 'Bounce',
  bars: 1,
  tracks: [{ name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 8 }] }],
  message: 'A bouncy kick.',
};

/** A fake /api/ai server: answers with the queued replies and records what was sent. */
function fakeServer(...replies: (object | (() => Response))[]) {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = replies.shift();
    if (typeof next === 'function') return next();
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const reply = (session: string, beat: unknown) => ({ session, beat, model: 'claude-opus-5-5' });
const ask = (chat: ClaudeBeatChat, prompt = 'p') =>
  chat.request({ prompt, project: '', model: 'claude-opus-5-5', backend: 'subscription' });

describe('ClaudeBeatChat', () => {
  it('sends the request with the schema, system prompt and context', async () => {
    const { sent, fetchImpl } = fakeServer(reply('s1', BEAT));
    const chat = new ClaudeBeatChat(fetchImpl);
    const { spec } = await chat.request({
      prompt: 'bouncy kick',
      project: 'Tempo 120 BPM',
      performance: { summary: 'bar 1: 1 kick(0.9)', role: 'drums', bars: 1, bpm: 120 },
      model: 'claude-opus-5-5',
      backend: 'api',
    });
    expect(spec).toMatchObject({ title: 'Bounce', message: 'A bouncy kick.' });
    const body = sent[0]!;
    expect(body).toMatchObject({ backend: 'api', model: 'claude-opus-5-5', session: null });
    expect(body.schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(String(body.system)).toContain('16 steps per bar');
    expect(body.text).toContain('bouncy kick');
    expect(body.text).toContain('Tempo 120 BPM');
    expect(body.text).toContain('instrument="drums (beatbox)"');
    expect(body.text).toContain('bar 1: 1 kick(0.9)');
    expect(chat.hasHistory).toBe(true);
  });

  it('continues the server-side conversation and starts over after reset', async () => {
    const { sent, fetchImpl } = fakeServer(
      reply('s1', BEAT),
      reply('s1', { ...BEAT, title: 'Bounce 2' }),
      reply('s2', BEAT),
    );
    const chat = new ClaudeBeatChat(fetchImpl);
    await ask(chat, 'a beat');
    const { spec } = await ask(chat, 'busier');
    expect(spec.title).toBe('Bounce 2');
    expect(sent[1]).toMatchObject({ session: 's1' });
    chat.reset();
    expect(chat.hasHistory).toBe(false);
    await ask(chat, 'new one');
    expect(sent[2]).toMatchObject({ session: null });
  });

  it('lets Claude fix a beat that does not validate', async () => {
    const { sent, fetchImpl } = fakeServer(reply('s1', { title: 'x', bars: 1, tracks: [] }), reply('s1', BEAT));
    const { spec } = await ask(new ClaudeBeatChat(fetchImpl));
    expect(spec.title).toBe('Bounce');
    expect(sent[1]).toMatchObject({ session: 's1' });
    expect(String(sent[1]!.text)).toMatch(/can't be used/);
  });

  it('maps server errors to kinds the UI can explain', async () => {
    const status = (code: number, type: string) => () =>
      new Response(JSON.stringify({ type: 'error', error: { type, message: 'm' } }), { status: code });
    const kinds = [];
    for (const [code, type] of [
      [503, 'not_configured'],
      [503, 'not_signed_in'],
      [401, 'authentication_error'],
      [429, 'rate_limit_error'],
      [529, 'overloaded_error'],
      [422, 'refusal'],
      [502, 'max_tokens'],
    ] as const) {
      const { fetchImpl } = fakeServer(status(code, type));
      kinds.push(await ask(new ClaudeBeatChat(fetchImpl)).catch((e: AiError) => e.kind));
    }
    expect(kinds).toEqual([
      'not-configured',
      'not-configured',
      'auth',
      'rate-limit',
      'overloaded',
      'refused',
      'bad-output',
    ]);
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(ask(new ClaudeBeatChat(offline))).rejects.toMatchObject({ kind: 'network' });
    expect(await fetchAiStatus(offline)).toMatchObject({ subscription: { ok: false }, api: { ok: false } });
  });
});

describe('describeProject', () => {
  it('summarizes tempo, channels and the current pattern', () => {
    const s = createTestServices();
    const p0 = s.doc.getState().project;
    const pat = p0.patternOrder[0]!;
    const kick = p0.channelOrder[0]!;
    s.history.transact('Steps', (d) => {
      for (const i of [0, 4, 8, 12]) setStep(d, pat, kick, i, true, { rootKey: 60 });
    });
    const text = describeProject(s.doc.getState().project, pat);
    expect(text).toContain('Tempo 130 BPM, 4/4');
    expect(text).toContain('Kick (kick)');
    expect(text).toContain('Hat (hat)');
    expect(text).toContain('Kick: 0 4 8 12');
  });
});
