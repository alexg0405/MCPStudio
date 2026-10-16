import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@core/model/ids';
import { createStore } from 'zustand/vanilla';
import { initialDecksState } from '../../dj/decks';
import type { DecksApi, DecksState } from '../../dj/decks-api';
import { library, type LibrarySong } from '../../dj/library';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { projectContext } from '../context';
import { STUDIO_PROMPT } from '../prompt';
import type { AiAction } from '../schema';
import { describeDeckAction, runDeckActions, type DeckAction } from './decks';

type S = ReturnType<typeof createTestServices>;
const run = (s: S, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });

const hex = (name: string) => [...name].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64);
const song = (label: string): LibrarySong => {
  const key = hex(label);
  return {
    key,
    ref: { id: newId.sample(), name: label, source: { kind: 'embedded', hash: key, ext: 'mp3' }, durationSec: 200 },
    title: label.split(' – ')[1]!,
    artist: label.split(' – ')[0]!,
    label,
    fileName: `${label}.mp3`,
    addedAt: 0,
  };
};

/** A DecksApi that records what it is asked (scripted answers never reach real audio). */
function fakeDecks() {
  const store = createStore<DecksState>(() => initialDecksState());
  const calls: string[] = [];
  const api = new Proxy({ store } as unknown as DecksApi, {
    get(target, prop: string) {
      if (prop in target) return (target as unknown as Record<string, unknown>)[prop];
      if (prop === 'then') return undefined;
      return (...args: unknown[]) => {
        calls.push(`${prop}(${args.map((a) => (typeof a === 'object' && a && 'title' in a ? 'song' : typeof a === 'object' ? 'ref' : String(a))).join(', ')})`);
        if (prop === 'load') {
          const [deck, , title, artist] = args as [keyof DecksState['decks'], unknown, string, string | undefined];
          store.setState((st) => ({ decks: { ...st.decks, [deck]: { ...st.decks[deck], song: { ref: args[1] as never, title, ...(artist ? { artist } : {}), durationSec: 200 }, baseBpm: 124, bpm: 124 } } }));
          return Promise.resolve();
        }
        return prop === 'startRecording' || prop === 'stopRecording' ? Promise.resolve(null) : undefined;
      };
    },
  });
  return { api, calls, store };
}

function withDecks(s: S) {
  const f = fakeDecks();
  let made: DecksApi | null = null;
  const access = Object.assign(async () => (made = f.api), { peek: () => made });
  (s as unknown as { decks: unknown }).decks = access;
  return f;
}

afterEach(() => library.setState({ songs: [], selected: [] }));

describe('deck actions (Studio)', () => {
  it('turns a blend into one request that runs after the answer, without touching the project', () => {
    const s = createTestServices();
    library.setState({ songs: [song('Nova – Midnight Run'), song('Kairo – Glass City')], selected: [] });
    const before = s.doc.getState().project;
    const res = run(s, [
      { op: 'deck_load', deck: 'A', song: 'midnight run' },
      { op: 'deck_load', deck: 'b', song: 'Glass City' },
      { op: 'deck_play', deck: 'A', action: 'play' },
      { op: 'deck_sync', deck: 'B' },
      { op: 'deck_set', deck: 'B', eq_low_db: -40, eq_high_db: 3, filter: 0.5, pitch_percent: 2.5, key_lock: true },
      { op: 'deck_crossfade', to: 'B', beats: 16 },
      { op: 'deck_loop', deck: 'A', beats: 4 },
      { op: 'deck_record', action: 'start' },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.edited).toBe(false);
    expect(s.doc.getState().project).toBe(before);
    const req = res.after.find((a) => a.kind === 'decks');
    expect(req?.kind === 'decks' && req.actions).toMatchObject([
      { do: 'load', deck: 'A', song: { title: 'Midnight Run' } },
      { do: 'load', deck: 'B', song: { title: 'Glass City' } },
      { do: 'play', deck: 'A', on: true },
      { do: 'sync', deck: 'B', on: true },
      { do: 'set', deck: 'B', eq: { low: -26, high: 3 }, filter: 0.5, pitch: 0.025, keyLock: true },
      { do: 'crossfade', to: 1, beats: 16 },
      { do: 'loop', deck: 'A', beats: 4 },
      { do: 'record', on: true },
    ]);
  });

  it('runs the actions on the decks in order', async () => {
    const s = createTestServices();
    const f = withDecks(s);
    const actions: DeckAction[] = [
      { do: 'load', deck: 'A', song: song('Nova – Midnight Run') },
      { do: 'play', deck: 'A', on: true },
      { do: 'sync', deck: 'B', on: true },
      { do: 'set', deck: 'B', eq: { low: -26 }, filter: -0.4, volume: 0.8, pitch: 0.05 },
      { do: 'crossfade', to: 1, beats: 32 },
      { do: 'crossfade', to: -1, beats: 0 },
      { do: 'loop', deck: 'A', beats: null },
      { do: 'loop', deck: 'A', beats: 8 },
      { do: 'record', on: false },
    ];
    expect(await runDeckActions(s, actions)).toEqual([]);
    expect(f.calls).toEqual([
      'load(A, ref, Midnight Run, Nova)',
      'play(A)',
      'sync(B, true)',
      'setPitch(B, 0.05)',
      'setEq(B, low, -26)',
      'setFilter(B, -0.4)',
      'setVolume(B, 0.8)',
      'crossfade(1, 32)',
      'setCrossfader(-1)',
      'exitLoop(A)',
      'autoLoop(A, 8)',
      'stopRecording()',
    ]);
  });

  it('a pitch beyond the range widens it first, and a failing action is reported while the rest run', async () => {
    const s = createTestServices();
    const f = withDecks(s);
    const failing = new Proxy(f.api, {
      get(t, p: string) {
        if (p === 'sync') return () => void (() => { throw new Error('no steady beat'); })();
        return (t as unknown as Record<string, unknown>)[p];
      },
    });
    (s as unknown as { decks: unknown }).decks = Object.assign(async () => failing, { peek: () => failing });
    const problems = await runDeckActions(s, [
      { do: 'set', deck: 'A', pitch: 0.12 },
      { do: 'sync', deck: 'A', on: true },
      { do: 'play', deck: 'A', on: false },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Deck A: sync to the other deck: no steady beat/);
    expect(f.calls).toEqual(['setPitchRange(A, 0.16)', 'setPitch(A, 0.12)', 'pause(A)']);
  });

  it('says what is wrong instead of guessing: unknown deck or song, nothing to set, bad crossfade', () => {
    const s = createTestServices();
    library.setState({ songs: [song('Nova – Midnight Run')], selected: [] });
    const res = run(s, [
      { op: 'deck_load', deck: 'Z', song: 'x' },
      { op: 'deck_load', deck: 'A', song: 'Never Heard Of It' },
      { op: 'deck_set', deck: 'A' },
      { op: 'deck_crossfade', to: 'left' },
      { op: 'deck_play', deck: 'A', action: 'dance' },
      { op: 'deck_loop', deck: 'A', beats: 'forever' },
    ]);
    expect(res.after.find((a) => a.kind === 'decks')).toBeUndefined();
    expect(res.warnings).toHaveLength(6);
    expect(res.warnings[0]).toMatch(/there is no deck/);
    expect(res.warnings[1]).toMatch(/no song “Never Heard Of It”/);
    expect(res.warnings[2]).toMatch(/nothing to set/);
  });

  it('an empty library explains that streaming services can’t be used', () => {
    const s = createTestServices();
    const res = run(s, [{ op: 'deck_load', deck: 'A', song: 'anything' }]);
    expect(res.warnings[0]).toMatch(/library is empty/);
    expect(res.warnings[0]).toMatch(/Spotify/);
  });

  it('clamps wild values to the decks’ ranges', () => {
    const s = createTestServices();
    const res = run(s, [{ op: 'deck_set', deck: 2, eq_mid_db: 99, filter: -9, volume: 7, trim_db: -99, pitch_percent: 400 }, { op: 'deck_crossfade', to: 5, beats: 9999 }]);
    const req = res.after.find((a) => a.kind === 'decks');
    expect(req?.kind === 'decks' && req.actions).toEqual([
      { do: 'set', deck: 'B', eq: { mid: 6 }, filter: -1, volume: 1.25, trimDb: -12, pitch: 0.5 },
      { do: 'crossfade', to: 1, beats: 256 },
    ]);
  });

  it('the context lists what is on the decks, and the prompt teaches the actions', async () => {
    const s = createTestServices();
    expect(projectContext(s)).not.toMatch(/<decks>/);
    const f = withDecks(s);
    await s.decks();
    await f.api.load('A', song('Nova – Midnight Run').ref, 'Midnight Run', 'Nova');
    f.store.setState((st) => ({ decks: { ...st.decks, A: { ...st.decks.A, playing: true, eq: { low: -26, mid: 0, high: 0 } } }, crossfader: -0.5 }));
    const ctx = projectContext(s);
    expect(ctx).toMatch(/<decks> \(live DJ decks; crossfader -0\.5/);
    expect(ctx).toMatch(/- Deck A: “Midnight Run” by Nova: 124 BPM, playing, EQ low -26 mid 0 high 0 dB, side A/);
    expect(STUDIO_PROMPT).toMatch(/DJ live decks \(deck_load/);
    expect(STUDIO_PROMPT).toMatch(/deck_crossfade/);
  });

  it('describes each action in plain words', () => {
    const lines = [
      describeDeckAction({ do: 'load', deck: 'A', song: song('Nova – Midnight Run') }),
      describeDeckAction({ do: 'crossfade', to: 1, beats: 16 }),
      describeDeckAction({ do: 'set', deck: 'B', eq: { low: -26 }, keyLock: true }),
      describeDeckAction({ do: 'record', on: true }),
    ];
    expect(lines).toEqual([
      'Deck A: loading “Nova – Midnight Run”',
      'Crossfader to B over 16 beats',
      'Deck B: low -26 dB, key lock on',
      'Recording the decks',
    ]);
  });
});
