import { describe, expect, it } from 'vitest';
import { createTestServices } from '../testing';
import { focusFromMarker } from '../ai/focus-capture';
import { stackedSong } from '../../../test/helpers/focus';
import { BeatAssistant } from './assistant';

const NO = { ok: false, reason: 'not set up' };
const offline = (async () =>
  new Response(JSON.stringify({ subscription: NO, api: NO }), { status: 200 })) as typeof fetch;

const answering = (actions: unknown[]) =>
  (async (url: string) => {
    if (url.endsWith('/status'))
      return new Response(JSON.stringify({ subscription: { ok: true }, api: NO }), { status: 200 });
    return new Response(
      JSON.stringify({ session: 'sess-e', model: 'claude-opus-5-5', beat: { message: 'Done.', actions } }),
      { status: 200 },
    );
  }) as typeof fetch;

describe('Studio chat edge cases', () => {
  it('a reload forgets the undo points of earlier answers (a new session numbers its steps again)', async () => {
    const saved = new Map<string, string>();
    const g = globalThis as { sessionStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> };
    g.sessionStorage = {
      getItem: (k) => saved.get(k) ?? null,
      setItem: (k, v) => void saved.set(k, v),
      removeItem: (k) => void saved.delete(k),
    };
    try {
      const s = createTestServices();
      const a = new BeatAssistant(s, { fetch: answering([{ op: 'song', bpm: 111 }]) });
      await a.send('tempo 111');
      await a.send('tempo again');
      expect(a.store.getState().messages.some((m) => m.undo !== undefined)).toBe(true);
      (a as unknown as { saveTab(): void }).saveTab();
      // A page reload: new services, so the history numbers its steps from 1 again.
      const after = new BeatAssistant(createTestServices(), { fetch: offline });
      const restored = after.store.getState().messages;
      expect(restored.length).toBeGreaterThan(0);
      for (const m of restored) {
        expect(m.undo).toBeUndefined();
        expect(m.beat?.cursor ?? -1).toBeLessThan(0);
      }
    } finally {
      delete g.sessionStorage;
    }
  });

  it('a new request retires an answer still waiting for approval, and New chat forgets it', async () => {
    const actions = [{ op: 'clear_playlist', from_bar: 81, to_bar: 84, trim: true }];
    const { s } = stackedSong();
    const verse = focusFromMarker(
      s,
      Object.values(s.doc.getState().project.playlist.markers).find((m) => m.name === 'Verse')!.id,
    )!;
    const a = new BeatAssistant(s, { fetch: answering(actions) });
    await a.send('clear the end', { focus: verse });
    const ask = a.store.getState().messages.at(-1)!;
    expect(ask.approval?.state).toBe('ask');
    const before = s.doc.getState().project;
    await a.send('hello again', { focus: verse });
    expect(a.store.getState().messages.find((m) => m.id === ask.id)?.approval?.state).toBe('expired');
    // Choosing on the old card now does nothing.
    await a.approve(ask.id, 'all');
    expect(Object.keys(s.doc.getState().project.playlist.clips).length).toBe(Object.keys(before.playlist.clips).length);
    a.newBeat();
    expect((a as unknown as { approvals: Map<number, unknown> }).approvals.size).toBe(0);
  });

  it('Stop works while it is still checking how to reach Claude', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async (url: string) => {
      if (url.endsWith('/status')) {
        await gate;
        return new Response(JSON.stringify({ subscription: NO, api: NO }), { status: 200 });
      }
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
    const s = createTestServices();
    const a = new BeatAssistant(s, { fetch: slow });
    const before = s.doc.getState().project;
    const sent = a.send('trap beat');
    await new Promise((r) => setTimeout(r, 5));
    expect(a.store.getState().phase).toBe('thinking');
    a.cancel();
    release();
    await sent;
    expect(a.store.getState().phase).toBe('idle');
    expect(a.store.getState().messages.at(-1)?.text).toBe('Stopped.');
    expect(s.doc.getState().project).toBe(before);
  });
});
