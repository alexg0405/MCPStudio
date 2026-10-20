/** "Make a full song…" with no AI set up: the offline song generator through the assistant, the arranger and the chord track. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STYLES, type Style } from '@core/beat/style';
import { formatChord } from '@core/harmony/chord';
import { planMelodyFit } from '@core/harmony/plan';
import type { Project } from '@core/model/types';
import { chordsSorted, patternChords } from '@core/query/chords';
import { generateSongFromPrompt } from '@core/song/generate';
import { checkArrangement } from '../arrange/check';
import { createTestServices } from '../testing';
import { registerAfterStep } from './after-steps';
import { BeatAssistant } from './assistant';
import { songToAnswer } from './song-answer';

const NO = { ok: false, reason: 'not set up' };
const offline = (async () => new Response(JSON.stringify({ subscription: NO, api: NO }), { status: 200 })) as typeof fetch;

/** Node has no OfflineAudioContext: the leveling step (a render) is left out; the browser test measures it. */
let removeLevelStep: () => void;
beforeEach(() => {
  removeLevelStep = registerAfterStep('level_mix', async () => null);
});
afterEach(() => removeLevelStep());

function setup() {
  const s = createTestServices();
  return { s, a: new BeatAssistant(s, { fetch: offline }) };
}

const project = (s: ReturnType<typeof createTestServices>): Project => s.doc.getState().project;
const markers = (p: Project) => Object.values(p.playlist.markers).sort((x, y) => x.tick - y.tick).map((m) => m.name);

describe('the offline song', () => {
  it('writes a whole song for "a sad trap song at 140": tempo, key, chords, patterns, sections and a mix', async () => {
    const { s, a } = setup();
    await a.send('a sad trap song at 140');
    const state = a.store.getState();
    expect(state.phase).toBe('idle');
    const reply = state.messages.at(-1)!;
    expect(reply).toMatchObject({ from: 'assistant', offline: true });
    expect(reply.text).toMatch(/sad trap song/);
    expect(reply.warnings).toBeUndefined();
    const p = project(s);
    expect(p.transport.bpm).toBe(140);
    expect(p.transport.key?.scale).toBe('minor');
    expect(markers(p)).toEqual(['Intro', 'Verse', 'Build', 'Hook', 'Verse 2', 'Build 2', 'Hook 2', 'Bridge', 'Hook 3', 'Outro']);
    expect(Object.keys(p.chords ?? {}).length).toBeGreaterThan(8);
    const names = Object.values(p.patterns).map((x) => x.name);
    for (const name of ['Intro', 'Verse', 'Verse melody', 'Chorus', 'Hook', 'Hook 2', 'Bridge melody']) expect(names).toContain(name);
    // The mix is set up by role (buses, returns, a master limiter) and the song is in song mode, playing.
    expect(p.mixer.order.length).toBeGreaterThan(6);
    expect(s.view.getState().mode).toBe('song');
    expect(s.engine.playing).toBe(true);
  });

  it('writes the song as one undo step', async () => {
    const { s, a } = setup();
    const before = project(s);
    const stepsBefore = s.history.steps().done.length;
    await a.send('uplifting house song');
    expect(s.history.steps().done.length - stepsBefore).toBe(1);
    s.history.undo();
    expect(project(s)).toEqual(before);
  });

  it('puts the chords on the chord track as the generator planned them', async () => {
    const { s, a } = setup();
    await a.send('a lofi song in D minor');
    const p = project(s);
    const plan = generateSongFromPrompt('a lofi song in D minor', { variation: 0 });
    const names = chordsSorted(p).map((entry) => formatChord({ root: entry.root, quality: entry.quality }, true));
    expect(names.length).toBeGreaterThan(4);
    const first = plan.chordLine.text.split('|')[0]!.trim();
    expect(formatChord({ root: chordsSorted(p)[0]!.root, quality: chordsSorted(p)[0]!.quality }, true)).toBe(first);
    expect(p.transport.key).toEqual({ root: 2, scale: 'minor' });
  });

  it('writes melodies that are already fit to the chord track (nothing for “fit melody” to move on a strong beat)', async () => {
    const { s, a } = setup();
    await a.send('a pop song in A minor');
    const p = project(s);
    for (const name of ['Verse melody', 'Hook', 'Bridge melody']) {
      const pattern = Object.values(p.patterns).find((x) => x.name === name)!;
      expect(patternChords(p, pattern.id).length, name).toBeGreaterThan(0);
      const lead = Object.entries(pattern.notes).find(([, notes]) => Object.keys(notes ?? {}).length > 0)!;
      const notes = Object.values(lead[1] ?? {});
      const plan = planMelodyFit(p, pattern.id, notes, { strength: 1 });
      expect(plan.withoutChord, name).toBe(0);
      expect(plan.changes, name).toEqual([]);
    }
  });

  it('gives another song when the same thing is asked for again, and the same one after New chat', async () => {
    const { s, a } = setup();
    await a.send('a house song');
    const first = chordsSorted(project(s)).map((entry) => `${entry.root}${entry.quality}`).join();
    await a.send('a house song');
    const second = chordsSorted(project(s)).map((entry) => `${entry.root}${entry.quality}`).join();
    expect(second).not.toBe(first);
    a.newBeat();
    await a.send('a house song');
    expect(chordsSorted(project(s)).map((entry) => `${entry.root}${entry.quality}`).join()).toBe(first);
  });

  it('still writes a beat for a request that is only a beat, and for a follow-up on a song', async () => {
    const { s, a } = setup();
    await a.send('trap beat with 808s');
    expect(Object.keys(project(s).chords ?? {})).toHaveLength(0);
    expect(project(s).playlist.markers).toEqual({});
    await a.send('a sad trap song');
    const patternsAfterSong = Object.keys(project(s).patterns).length;
    await a.send('busier hats');
    expect(Object.keys(project(s).patterns).length).toBe(patternsAfterSong + 1);
    expect(markers(project(s)).length).toBe(10);
  });

  it('turns the answer into the actions an AI would write: song, chords, a beat per pattern, one arrange', () => {
    const plan = generateSongFromPrompt('a trance song', { seed: 3 });
    const answer = songToAnswer(plan);
    expect(answer.actions.map((action) => action.op)).toEqual(['song', 'chords', ...plan.patterns.map(() => 'beat'), 'arrange']);
    const arrange = answer.actions.at(-1)!;
    expect(arrange).toMatchObject({ style: 'trance', mix: 'auto' });
    const refs = new Set(plan.patterns.map((entry) => entry.ref));
    for (const section of arrange.sections as { play: string[] }[]) for (const ref of section.play) expect(refs.has(ref)).toBe(true);
  });

  it.each(STYLES.map((style) => [style] as const))('%s: the arrangement check finds no bugs, and every beat applies without a warning', async (style: Style) => {
    const { s, a } = setup();
    await a.send(`a ${style === 'edm' ? 'edm' : style} song`);
    const reply = a.store.getState().messages.at(-1)!;
    expect(reply.warnings, reply.text).toBeUndefined();
    const found = checkArrangement(s, project(s), { style }).filter((finding) => finding.severity === 'bug');
    expect(found).toEqual([]);
  });
});
