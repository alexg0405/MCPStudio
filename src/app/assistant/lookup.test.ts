/**
 * Studio looking before it acts: an answer with `query` actions gets the read tools' results with the
 * request again (fake fetch, no real Claude), and answers for real; look-ups are capped.
 */
import { describe, expect, it } from 'vitest';
import { project, stackedSong } from '../../../test/helpers/focus';
import { BeatAssistant } from './assistant';

const NO = { ok: false, reason: 'not set up' };

/** Claude, scripted: one answer per call (the last repeats). */
function scripted(answers: { message: string; actions: unknown[] }[]) {
  const calls: Record<string, unknown>[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/status')) return new Response(JSON.stringify({ subscription: { ok: true }, api: NO }), { status: 200 });
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const beat = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return new Response(JSON.stringify({ session: 'sess-q', model: 'claude-opus-5-5', beat }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('Studio looks things up (query actions)', () => {
  it('asks again with what it read, then answers for real, as one undo step', async () => {
    const { fetchImpl, calls } = scripted([
      { message: 'Let me look at the kick.', actions: [{ op: 'query', tool: 'get_pattern_notes', args_json: '{"pattern":"Drop","channel":"Kick"}' }] },
      { message: 'Added a kick on the last 16th.', actions: [{ op: 'write_notes', pattern: 'Drop', channel: 'Kick', replace: false, notes: [{ step: 15 }] }] },
    ]);
    const { s } = stackedSong();
    const a = new BeatAssistant(s, { fetch: fetchImpl });
    const steps = s.history.steps().done.length;
    await a.send('add one more kick at the end of the drop');
    expect(calls).toHaveLength(2);
    expect(String(calls[0]!.text)).not.toContain('<lookups>');
    const second = String(calls[1]!.text);
    expect(second).toContain('<lookups>');
    expect(second).toContain('get_pattern_notes {"pattern":"Drop","channel":"Kick"}');
    expect(second).toContain('[0,1,60,0.9]');
    expect(second).toContain('add one more kick at the end of the drop');
    const kick = Object.values(project(s).channels).find((c) => c.name === 'Kick')!.id;
    const drop = Object.values(project(s).patterns).find((p) => p.name === 'Drop')!;
    expect(Object.values(drop.notes[kick]!).some((n) => n.tick === 15 * 240)).toBe(true);
    expect(s.history.steps().done.length - steps).toBe(1);
    const st = a.store.getState();
    expect(st.phase).toBe('idle');
    expect(st.messages.map((m) => m.from)).toEqual(['you', 'assistant', 'assistant']);
    expect(st.messages.at(-1)).toMatchObject({ text: 'Added a kick on the last 16th.' });
  });

  it('says what a bad look-up was and still answers', async () => {
    const { fetchImpl, calls } = scripted([
      { message: 'Looking.', actions: [{ op: 'query', tool: 'get_channel', args_json: '{"channel":"Nobody"}' }] },
      { message: 'There is no channel by that name.', actions: [] },
    ]);
    const { s } = stackedSong();
    const a = new BeatAssistant(s, { fetch: fetchImpl });
    await a.send('what is on the nobody channel?');
    expect(calls).toHaveLength(2);
    expect(String(calls[1]!.text)).toContain('"error"');
    expect(a.store.getState().messages.at(-1)).toMatchObject({ text: 'There is no channel by that name.' });
  });

  it('stops after three rounds of look-ups', async () => {
    const { fetchImpl, calls } = scripted([
      { message: 'Looking again.', actions: [{ op: 'query', tool: 'get_transport' }] },
    ]);
    const { s } = stackedSong();
    const a = new BeatAssistant(s, { fetch: fetchImpl });
    await a.send('loop forever');
    expect(calls).toHaveLength(4);
    expect(a.store.getState().phase).toBe('idle');
    expect(a.store.getState().messages.at(-1)?.text).toMatch(/one part at a time/);
  });
});
