import { describe, expect, it } from 'vitest';
import type { GridEvent } from '@core/voice';
import { createTestServices } from '../testing';
import { BeatAssistant, inferRole, type Take } from './assistant';

const NO = { ok: false, reason: 'not set up' };
const offline = (async () =>
  new Response(JSON.stringify({ subscription: NO, api: NO }), { status: 200 })) as typeof fetch;

function setup(fetchImpl: typeof fetch = offline) {
  const s = createTestServices();
  const a = new BeatAssistant(s, { fetch: fetchImpl });
  return { s, a };
}

const hum = (step: number, lengthSteps: number, pitch: number): GridEvent =>
  ({
    time: step * 0.1,
    duration: lengthSteps * 0.1,
    strength: 0.9,
    kind: 'tonal',
    confidence: 0.9,
    pitch,
    pitchEnd: null,
    features: { centroid: 300, lowRatio: 0.5, highRatio: 0, zcr: 0.01, periodicity: 0.9 },
    step,
    lengthSteps,
    offsetMs: 0,
  }) as GridEvent;

describe('BeatAssistant', () => {
  it('writes a beat offline when no Claude key is set, and plays it', async () => {
    const { s, a } = setup();
    await a.send('trap beat with 808s');
    const st = a.store.getState();
    expect(st.status).toMatchObject({ subscription: { ok: false }, api: { ok: false } });
    expect(st.phase).toBe('idle');
    expect(st.messages.map((m) => m.from)).toEqual(['you', 'assistant']);
    expect(st.messages[1]).toMatchObject({ offline: true });
    const p = s.doc.getState().project;
    const pattern = p.patterns[st.applied!.patternId]!;
    expect(pattern.name).toMatch(/trap/i);
    expect(p.transport.bpm).toBe(140);
    expect(s.view.getState().currentPatternId).toBe(pattern.id);
    expect(s.engine.playing).toBe(true);
  });

  it('changes the same pattern on a follow-up and starts over after New beat', async () => {
    const { s, a } = setup();
    await a.send('trap beat');
    const first = a.store.getState().applied!.patternId;
    await a.send('busier');
    expect(a.store.getState().applied!.patternId).toBe(first);
    a.newBeat();
    expect(a.store.getState().messages).toEqual([]);
    await a.send('boom bap');
    expect(a.store.getState().applied!.patternId).not.toBe(first);
    expect(s.doc.getState().project.patternOrder).toContain(first);
  });

  it('turns a hummed take into the 808 line', async () => {
    const { s, a } = setup();
    const take: Take = {
      events: [hum(0, 4, 50), hum(4, 4, 53), hum(8, 6, 55), hum(14, 2, 50)],
      summary: '',
      role: '808',
      bars: 1,
      bpm: 140,
      audio: { samples: new Float32Array(10), sampleRate: 48000, startSec: 0 },
      sent: false,
    };
    a.set({ take });
    await a.send('808s like this, trap');
    const st = a.store.getState();
    const p = s.doc.getState().project;
    const id = st.applied!.channels['808']!;
    const notes = Object.values(p.patterns[st.applied!.patternId]!.notes[id] ?? {}).sort((x, y) => x.tick - y.tick);
    expect(notes.map((n) => n.tick)).toEqual([0, 960, 1920, 3360]);
    expect(notes.map((n) => n.key - notes[0]!.key)).toEqual([0, 3, 5, 0]);
    expect(st.messages[0]?.detail).toMatch(/1-bar take/);
  });

  it('asks Claude through the subscription when it is set up, and reports its errors', async () => {
    const calls: Record<string, unknown>[] = [];
    let n = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status'))
        return new Response(JSON.stringify({ subscription: { ok: true }, api: NO }), { status: 200 });
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (n++ > 0)
        return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), {
          status: 529,
        });
      return new Response(
        JSON.stringify({
          session: 'sess-1',
          model: 'claude-opus-5-5',
          beat: {
            message: 'Here you go.',
            actions: [
              {
                op: 'beat',
                title: 'Claude beat',
                bars: 1,
                tracks: [{ name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 8 }] }],
              },
              { op: 'song', bpm: 126 },
            ],
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const { s, a } = setup(fetchImpl);
    await a.send('four on the floor');
    let st = a.store.getState();
    expect(calls[0]).toMatchObject({ backend: 'subscription', session: null });
    expect(st.messages[1]).toMatchObject({ text: 'Here you go.' });
    expect(st.messages[1]?.offline).toBeUndefined();
    expect(st.messages[1]?.changes).toEqual(['Wrote the beat “Claude beat” (Kick)', 'Song: tempo 126 BPM']);
    expect(s.doc.getState().project.patterns[st.applied!.patternId]?.name).toBe('Claude beat');
    expect(s.doc.getState().project.transport.bpm).toBe(126);
    // The first turn carries the plugin catalog and the project; later ones only what changed.
    expect(String(calls[0]!.text)).toContain('<plugins>');
    expect(String(calls[0]!.text)).toContain('<project>');
    // One undo step undoes the whole answer.
    s.history.undo();
    expect(s.doc.getState().project.transport.bpm).not.toBe(126);
    expect(s.doc.getState().project.patterns[st.applied!.patternId]).toBeUndefined();
    s.history.redo();
    await a.send('busier');
    st = a.store.getState();
    expect(calls[1]).toMatchObject({ session: 'sess-1' });
    expect(st.messages.at(-1)).toMatchObject({ error: true });
  });

  it('keeps the conversation and its pattern across a page reload', async () => {
    const saved = new Map<string, string>();
    const g = globalThis as { sessionStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> };
    g.sessionStorage = {
      getItem: (k) => saved.get(k) ?? null,
      setItem: (k, v) => void saved.set(k, v),
      removeItem: (k) => void saved.delete(k),
    };
    try {
      const { s, a } = setup();
      await a.send('trap');
      (a as unknown as { saveTab(): void }).saveTab();
      const after = new BeatAssistant(s, { fetch: offline });
      const st = after.store.getState();
      expect(st.messages.map((m) => m.from)).toEqual(['you', 'assistant']);
      expect(st.applied?.patternId).toBe(a.store.getState().applied?.patternId);
      // A follow-up after the reload still changes the same pattern.
      await after.send('busier');
      expect(after.store.getState().applied?.patternId).toBe(st.applied?.patternId);
    } finally {
      delete g.sessionStorage;
    }
  });

  it('uses the offline generator when chosen, even with Claude set up', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ subscription: { ok: true }, api: { ok: true } }), { status: 200 })) as typeof fetch;
    const { a } = setup(fetchImpl);
    a.set({ backend: 'offline' });
    await a.send('trap');
    expect(a.store.getState().messages[1]).toMatchObject({ offline: true });
  });
});

describe('inferRole', () => {
  it('reads what a take is from the request', () => {
    expect(inferRole('i want 808s that go like this')).toBe('808');
    expect(inferRole('make my bass line hit harder')).toBe('808');
    expect(inferRole('turn my humming into a melody')).toBe('melody');
    expect(inferRole('use my beatbox for the drums')).toBe('drums');
    expect(inferRole('make it darker')).toBeNull();
  });
});
