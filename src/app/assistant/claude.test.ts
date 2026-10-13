import { describe, expect, it } from 'vitest';
import { setStep } from '@core/ops/notes';
import { createTestServices } from '../testing';
import { AiError, ClaudeBeatChat, aiConfigured } from './claude';
import { describeProject } from './context';

const BEAT = {
  title: 'Bounce',
  bars: 1,
  tracks: [{ name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 8 }] }],
  message: 'A bouncy kick.',
};

/** A fake /api/ai server: answers with the queued responses and records what was sent. */
function fakeServer(...replies: (object | ((body: Record<string, unknown>) => Response))[]) {
  const sent: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(body);
    const next = replies.shift();
    if (typeof next === 'function') return next(body);
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

const toolUse = (id: string, input: unknown, stop_reason = 'tool_use') => ({
  content: [{ type: 'tool_use', id, name: 'write_beat', input }],
  stop_reason,
});

describe('ClaudeBeatChat', () => {
  it('asks for a beat with the tool forced and the context in the message', async () => {
    const { sent, fetchImpl } = fakeServer(toolUse('t1', BEAT));
    const chat = new ClaudeBeatChat(fetchImpl);
    const { spec } = await chat.request({
      prompt: 'bouncy kick',
      project: 'Tempo 120 BPM',
      performance: { summary: 'bar 1: 1 kick(0.9)', role: 'drums', bars: 1, bpm: 120 },
      model: 'claude-opus-5-5',
    });
    expect(spec).toMatchObject({ title: 'Bounce', message: 'A bouncy kick.' });
    const body = sent[0]!;
    expect(body).toMatchObject({ model: 'claude-opus-5-5', tool_choice: { type: 'tool', name: 'write_beat' } });
    const first = (body.messages as { content: string }[])[0]!.content;
    expect(first).toContain('bouncy kick');
    expect(first).toContain('Tempo 120 BPM');
    expect(first).toContain('instrument="drums (beatbox)"');
    expect(first).toContain('bar 1: 1 kick(0.9)');
    expect(chat.hasHistory).toBe(true);
  });

  it('continues the conversation, answering the previous tool call', async () => {
    const { sent, fetchImpl } = fakeServer(toolUse('t1', BEAT), toolUse('t2', { ...BEAT, title: 'Bounce 2' }));
    const chat = new ClaudeBeatChat(fetchImpl);
    await chat.request({ prompt: 'a beat', project: '', model: 'm' });
    const { spec } = await chat.request({ prompt: 'busier', project: '', model: 'm' });
    expect(spec.title).toBe('Bounce 2');
    const messages = sent[1]!.messages as { role: string; content: unknown }[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2]!.content).toMatchObject([
      { type: 'tool_result', tool_use_id: 't1' },
      { type: 'text', text: expect.stringContaining('busier') },
    ]);
    chat.reset();
    expect(chat.hasHistory).toBe(false);
  });

  it('lets Claude fix a beat that does not validate', async () => {
    const { sent, fetchImpl } = fakeServer(toolUse('bad', { title: 'x', bars: 1, tracks: [] }), toolUse('good', BEAT));
    const { spec } = await new ClaudeBeatChat(fetchImpl).request({ prompt: 'p', project: '', model: 'm' });
    expect(spec.title).toBe('Bounce');
    const retry = sent[1]!.messages as { content: unknown }[];
    expect(retry.at(-1)!.content).toMatchObject([{ type: 'tool_result', tool_use_id: 'bad', is_error: true }]);
  });

  it('reports cut-off answers and missing tool calls', async () => {
    const cut = fakeServer(toolUse('t', BEAT, 'max_tokens'));
    await expect(
      new ClaudeBeatChat(cut.fetchImpl).request({ prompt: 'p', project: '', model: 'm' }),
    ).rejects.toMatchObject({
      kind: 'bad-output',
    });
    const chatty = fakeServer({ content: [{ type: 'text', text: 'hi' }] });
    await expect(
      new ClaudeBeatChat(chatty.fetchImpl).request({ prompt: 'p', project: '', model: 'm' }),
    ).rejects.toBeInstanceOf(AiError);
  });

  it('maps server errors to kinds the UI can explain', async () => {
    const status = (code: number, type: string) => () =>
      new Response(JSON.stringify({ type: 'error', error: { type, message: 'm' } }), { status: code });
    const kinds = [];
    for (const [code, type] of [
      [503, 'not_configured'],
      [401, 'authentication_error'],
      [429, 'rate_limit_error'],
      [529, 'overloaded_error'],
    ] as const) {
      const { fetchImpl } = fakeServer(status(code, type));
      kinds.push(
        await new ClaudeBeatChat(fetchImpl)
          .request({ prompt: 'p', project: '', model: 'm' })
          .catch((e: AiError) => e.kind),
      );
    }
    expect(kinds).toEqual(['not-configured', 'auth', 'rate-limit', 'overloaded']);
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(new ClaudeBeatChat(offline).request({ prompt: 'p', project: '', model: 'm' })).rejects.toMatchObject({
      kind: 'network',
    });
    expect(await aiConfigured(offline)).toBe(false);
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
