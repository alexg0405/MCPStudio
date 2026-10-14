import { describe, expect, it, vi } from 'vitest';
import type { GridEvent } from '@core/voice';
import { MASTER } from '@core/model/types';
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

  it('runs app commands: plain ones at once, file dialogs after the musician’s click', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/status'))
        return new Response(JSON.stringify({ subscription: { ok: true }, api: NO }), { status: 200 });
      return new Response(
        JSON.stringify({
          session: 'sess-2',
          model: 'claude-opus-5-5',
          beat: {
            message: 'Metronome on, and your project is ready to save.',
            actions: [
              { op: 'command', id: 'test.metronome' },
              { op: 'command', id: 'test.save' },
              { op: 'command', id: 'test.nope' },
            ],
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const { s, a } = setup(fetchImpl);
    let clicks = 0;
    let saves = 0;
    s.commands.register({ id: 'test.metronome', title: 'Metronome', hint: 'Click on every beat', run: () => void clicks++ });
    s.commands.register({ id: 'test.save', title: 'Save…', hint: 'Save the project', gesture: true, run: () => void saves++ });
    s.commands.register({ id: 'test.nope', title: 'Hidden', ai: false, run: () => {} });
    await a.send('turn the metronome on and save');
    const st = a.store.getState();
    expect(clicks).toBe(1);
    // The file command waits: the UI asks for a click (the gesture its file dialog needs).
    expect(saves).toBe(0);
    expect(st.uiRequests).toEqual([{ kind: 'command', id: 'test.save', gesture: true }]);
    expect(st.messages.at(-1)?.changes).toEqual(['Ran “Metronome”', 'Save: waiting for your click']);
    expect(st.messages.at(-1)?.warnings).toEqual(['command: there is no command "test.nope"']);
  });

  it('tells Claude what the app can do: the command list with the first turn', async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status'))
        return new Response(JSON.stringify({ subscription: { ok: true }, api: NO }), { status: 200 });
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ session: 'sess-3', model: 'claude-opus-5-5', beat: { message: 'Hi.', actions: [] } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const { s, a } = setup(fetchImpl);
    s.commands.register({ id: 'file.save', title: 'Save', hint: 'Save the project to its file', gesture: true, run: () => {} });
    await a.send('hello');
    const text = String(calls[0]!.text);
    expect(text).toContain('<commands>');
    expect(text).toContain('- file.save "Save": Save the project to its file [the musician confirms with one click]');
    expect(text).toMatch(/App: file "Untitled" \(saved\)/);
    await a.send('again');
    expect(String(calls[1]!.text)).not.toContain('<commands>');
  });

  it('builds a plugin the answer asks for, then installs it with one click', async () => {
    const posted: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      posted.push(url);
      if (url.endsWith('/status'))
        return new Response(JSON.stringify({ subscription: { ok: true }, api: NO }), { status: 200 });
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (url === '/api/ai/chat' && String(body.system).startsWith('You write plugins'))
        return new Response(
          JSON.stringify({
            session: 'build',
            model: 'claude-opus-5-5',
            beat: {
              message: 'Tape Stop slows your track to a halt.',
              plugin: {
                id: 'user.tape-stop',
                name: 'Tape Stop',
                kind: 'effect',
                files: [{ path: 'index.ts', content: 'export default {};' }],
              },
            },
          }),
          { status: 200 },
        );
      if (url === '/api/ai/chat')
        return new Response(
          JSON.stringify({
            session: 'studio',
            model: 'claude-opus-5-5',
            beat: {
              message: 'Building you a tape stop effect.',
              actions: [{ op: 'build_plugin', name: 'Tape Stop', kind: 'effect', description: 'Slows audio to a stop.' }],
            },
          }),
          { status: 200 },
        );
      if (url === '/api/plugins/draft')
        return new Response(JSON.stringify({ folder: 'tape-stop', problems: [] }), { status: 200 });
      if (url === '/api/plugins/install')
        return new Response(JSON.stringify({ folder: 'tape-stop', replaced: false }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const s = createTestServices();
    const a = new BeatAssistant(s, { fetch: fetchImpl, smoke: async () => ({ problems: [], peakDb: -12 }) });
    await a.send('make me a tape stop plugin');
    await vi.waitFor(() => expect(a.store.getState().building).toBeNull());
    const card = a.store.getState().messages.at(-1)!;
    expect(card.plugin).toMatchObject({ state: 'draft', draft: { id: 'user.tape-stop', folder: 'tape-stop' } });
    expect(card.detail).toContain('peak -12 dBFS');
    // Install: the draft moves into plugins/, and hot reload brings it into the registry.
    const installing = a.installPlugin(card.id);
    s.plugins.sync('user', [
      {
        path: '/plugins/tape-stop/index.ts',
        def: {
          kind: 'effect',
          id: 'user.tape-stop',
          name: 'Tape Stop',
          version: 1,
          params: {},
          create: () => ({ input: null, output: null, dispose: () => {} }),
        },
      },
    ]);
    await installing;
    expect(posted).toContain('/api/plugins/install');
    expect(a.store.getState().messages.at(-1)!.plugin!.state).toBe('installed');
  });

  it('listens to the mix when the answer asks, then asks again with the analysis', async () => {
    const texts: string[] = [];
    let turn = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status'))
        return new Response(JSON.stringify({ subscription: { ok: true }, api: NO }), { status: 200 });
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
      texts.push(String(body.text ?? ''));
      const answer =
        turn++ === 0
          ? { message: 'Listening to your mix…', actions: [{ op: 'analyze_mix' }] }
          : { message: 'Turned the master down.', actions: [{ op: 'edit_insert', insert: 'master', volume_db: -2 }] };
      return new Response(JSON.stringify({ session: 'studio', model: 'claude-opus-5-5', beat: answer }), { status: 200 });
    }) as typeof fetch;
    const s = createTestServices();
    const master = { lufs: -7, shortTermMax: -6, peakDb: -0.1, truePeakDb: 0.4, rmsDb: -8, crestDb: 8, bands: [20, 30, 20, 15, 10, 5], width: 0.2, correlation: 0.9, silent: false };
    const analyze = vi.fn(async (_s: unknown, opts?: { onProgress?(f: number, l: string): void }) => {
      opts?.onProgress?.(0.5, 'Drums');
      return { what: '8 s: bars 1–4 of the song', seconds: 8, master, tracks: [], notes: ['The master is very loud (−7.0 LUFS).'] };
    });
    const a = new BeatAssistant(s, { fetch: fetchImpl, analyze });
    await a.send('mix my song');
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(texts).toHaveLength(2);
    expect(texts[0]).not.toContain('<mix-analysis>');
    expect(texts[1]).toContain('<mix-analysis>');
    expect(texts[1]).toContain('Master (what you hear, after its effects): −7.0 LUFS');
    expect(texts[1]).toContain('<request>\nmix my song\n</request>');
    const st = a.store.getState();
    expect(st.phase).toBe('idle');
    const heard = st.messages.find((m) => m.findings);
    expect(heard?.text).toBe('I listened to 8 s: bars 1–4 of the song.');
    expect(heard?.findings).toEqual(['The master is very loud (−7.0 LUFS).']);
    expect(st.messages.at(-1)?.text).toBe('Turned the master down.');
    expect(s.doc.getState().project.mixer.inserts[MASTER]?.volume).toBeLessThan(1);
  });

  it('“Check my mix” listens first and asks once', async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/status'))
        return new Response(JSON.stringify({ subscription: { ok: true }, api: NO }), { status: 200 });
      calls++;
      // Even if it asks to listen again, the follow-up doesn't loop.
      return new Response(
        JSON.stringify({ session: 'studio', model: 'm', beat: { message: 'Done.', actions: [{ op: 'analyze_mix' }] } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const s = createTestServices();
    const analyze = vi.fn(async () => ({
      what: '8 s',
      seconds: 8,
      master: { lufs: -14, shortTermMax: -12, peakDb: -3, truePeakDb: -2, rmsDb: -15, crestDb: 12, bands: [10, 20, 25, 25, 15, 5], width: 0.2, correlation: 0.8, silent: false },
      tracks: [],
      notes: [],
    }));
    const a = new BeatAssistant(s, { fetch: fetchImpl, analyze });
    await a.checkMix();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
    expect(a.store.getState().messages[0]?.from).toBe('you');
    expect(a.store.getState().phase).toBe('idle');
  });

  it('shows what it hears even without Claude', async () => {
    const s = createTestServices();
    const analyze = vi.fn(async () => ({
      what: '8 s',
      seconds: 8,
      master: { lufs: -24, shortTermMax: -22, peakDb: -9, truePeakDb: -8.5, rmsDb: -25, crestDb: 16, bands: [10, 20, 25, 25, 15, 5], width: 0.2, correlation: 0.8, silent: false },
      tracks: [],
      notes: ['The master is quiet (−24.0 LUFS).'],
    }));
    const a = new BeatAssistant(s, { fetch: offline, analyze });
    await a.checkMix();
    const msgs = a.store.getState().messages;
    expect(msgs.find((m) => m.findings)?.findings).toEqual(['The master is quiet (−24.0 LUFS).']);
    expect(msgs.at(-1)).toMatchObject({ offline: true });
    expect(a.store.getState().phase).toBe('idle');
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
