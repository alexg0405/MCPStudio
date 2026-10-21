/**
 * The offline edit interpreter on a song the v2 generator wrote: a table of plain phrasings and the actions each one becomes
 * (the same kind of actions an AI's answer carries), what part of the song each holds the answer to, and the replies for words
 * it cannot do. The interpreter is pure, so every row reads the same project.
 */
import { produce } from 'immer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { interpretEdit } from '@core/offline-edit/interpret';
import type { BarRange, EditOutcome, OfflineAction } from '@core/offline-edit/types';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { MASTER, type AudioClip, type AudioClipChannel, type Project } from '@core/model/types';
import { rolesOf } from '../arrange/env';
import { createTestServices } from '../testing';
import { registerAfterStep } from './after-steps';
import { BeatAssistant } from './assistant';

const NO = { ok: false, reason: 'not set up' };
const offline = (async () => new Response(JSON.stringify({ subscription: NO, api: NO }), { status: 200 })) as typeof fetch;

/** The v2 generator's song for "a sad trap song at 140": Intro 1–4, Verse 5–12, Build 13–16, Hook 17–24, Verse 2 25–32… */
let song: Project;
let removeLevelStep: () => void;

beforeAll(async () => {
  removeLevelStep = registerAfterStep('level_mix', async () => null);
  const services = createTestServices();
  const assistant = new BeatAssistant(services, { fetch: offline });
  await assistant.send('a sad trap song at 140');
  song = services.doc.getState().project;
});
afterAll(() => removeLevelStep());

/** "op", "op:kind" or "op:action", each once, in alphabetical order (which pattern comes first does not matter). */
function signature(actions: readonly OfflineAction[]): string[] {
  const names = actions.map((action) => {
    const detail = typeof action.kind === 'string' ? action.kind : typeof action.action === 'string' ? action.action : '';
    return detail ? `${action.op}:${detail}` : action.op;
  });
  return [...new Set(names)].sort();
}

function interpret(text: string, project: Project = song, focus: { range: BarRange; label: string } | null = null): EditOutcome {
  return interpretEdit({ text, project, roles: rolesOf(project), focus, variation: 0 });
}

/** A field of an action, as the test expects it to be. */
const field = <T,>(action: OfflineAction | undefined, name: string): T => action?.[name] as T;

/** What a row expects: the actions it becomes, a reply, or that the words are not an edit at all. */
type Expected = readonly string[] | RegExp | 'none';

/** One song with a recorded vocal on its playlist, for the vocal rows. */
function songWithVocal(): Project {
  const sampleId = newId.sample();
  const channel: AudioClipChannel = {
    kind: 'audioClip',
    id: newId.channel(),
    name: 'Vocal',
    color: '#5f8fbf',
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    output: MASTER,
    sampleId,
  };
  return produce(song, (draft) => {
    draft.samples[sampleId] = { id: sampleId, name: 'Vocal', source: { kind: 'embedded', hash: 'vocal-hash', ext: 'wav' } };
    draft.channels[channel.id] = channel;
    draft.channelOrder.push(channel.id);
    const clip: AudioClip = {
      kind: 'audio',
      id: newId.clip(),
      laneId: draft.playlist.laneOrder[draft.playlist.laneOrder.length - 1]!,
      start: 3840 * 16,
      length: 3840 * 8,
      channelId: channel.id,
      offsetSec: 0,
    };
    draft.playlist.clips[clip.id] = clip;
  });
}

describe('phrasings on a generated song', () => {
  const rows: readonly (readonly [string, Expected])[] = [
    // Drums
    ['busier hats', ['vary:double_hats']],
    ['make the hats a lot busier in the chorus', ['vary:double_hats', 'vary:hat_roll']],
    ['more hi-hats in bars 17-24', ['vary:double_hats']],
    ['simpler drums in the first verse', ['vary:thin']],
    ['make the beat a bit less busy', ['vary:thin']],
    ['the hats are too busy', ['vary:thin']],
    ['simpler drums in the bridge', /no drums in the Bridge/],
    ['no hats in bars 9-16', ['vary:without']],
    ['remove the hats and the kick in the chorus', ['vary:without']],
    ['take the kick out of the intro', /no kick in the Intro/],
    ['add a fill at the end of the second verse', ['vary:fill']],
    ['add hat rolls', ['vary:hat_roll']],
    // Hit harder
    ['make the kick and snare hit harder', ['note_tool', 'add_effect']],
    ['punchier drums in bars 5-12', ['note_tool']],
    ['make the snare hit harder', ['note_tool', 'add_effect']],
    // A new melody
    ['write a new melody for the chorus', ['write_notes']],
    ['a different hook for the last chorus', ['write_notes']],
    ['new lead', ['write_notes']],
    ['rewrite the verse melody', ['write_notes']],
    ['give me a fresh hook', ['write_notes']],
    // Chords
    ['change the chords', ['chords:progression', 'voice_chords', 'bassline', 'fit_melody']],
    ['change the chords in bars 9-16', ['chords:progression', 'voice_chords', 'bassline', 'fit_melody']],
    ['make the chords darker', ['chords:progression', 'voice_chords', 'bassline', 'fit_melody']],
    ['use seventh chords', ['chords:progression', 'voice_chords', 'bassline', 'fit_melody']],
    ['make it sadder', ['chords:progression', 'voice_chords', 'bassline', 'fit_melody']],
    ['swap the chords in the bridge', ['chords:progression', 'voice_chords', 'fit_melody']],
    ['re-harmonize the chorus', ['chords:progression', 'voice_chords', 'bassline', 'fit_melody']],
    // Key, tempo and swing
    ['transpose up 2 semitones', ['song', 'chords:set', 'note_tool']],
    ['change the key to f minor', ['song', 'chords:set', 'note_tool']],
    ['transpose up an octave', ['note_tool']],
    ['change key to c major', /major and minor/],
    ['what key is this in', /G# minor/],
    ['tempo 128', ['song']],
    ['set the bpm to 150', ['song']],
    ['a bit faster', ['song']],
    ['slow it down a lot', ['song']],
    ['double time', ['song']],
    ['more swing', ['song']],
    ['no swing', /already 0 %/],
    // Parts of the song
    ['add a breakdown', ['vary:without', 'transition:dip', 'transition:rise']],
    ['make bars 25-32 a breakdown', ['vary:without', 'marker:edit', 'transition:dip', 'transition:rise']],
    ['add a build before the last chorus', ['vary:double_hats', 'vary:hat_roll', 'transition:rise']],
    ['add a drop', ['transition:rise', 'vary:crash', 'marker:edit']],
    ['add an outro', /already ends with an outro/],
    ['add an intro', /move the whole song/],
    // Variation and transitions
    ['smoother transitions', ['develop']],
    ['more variation', ['develop']],
    ['add a riser into the chorus', ['transition:riser']],
    ['add a crash into bar 17', ['transition:crash']],
    ['add a fill into the chorus', ['transition:fill']],
    // Vocals (this song has no recording)
    ['clean up the vocal', /no recorded vocal/],
    ['add harmonies to the vocal', /no recorded vocal/],
    // Mix
    ['turn the lead up 3 dB', ['edit_insert']],
    ['quieter drums', ['edit_insert']],
    ['more bass', ['edit_insert']],
    ['make the lead louder in the chorus', ['automate']],
    ['more reverb on the lead', ['route']],
    ['less reverb', ['route']],
    ['make the pads wider', ['add_effect']],
    ['mute the hats', ['edit_channel']],
    ['mute the hats in the first verse', ['vary:without']],
    ['pan the lead right', ['edit_insert']],
    ['level the mix', ['setup_mix', 'level_mix']],
    ['more reverb on the vocals', /no vocals/],
    // Style
    ['make it sound like house', ['song', 'write_notes', 'bassline']],
    ['turn it into lo-fi', ['song', 'write_notes', 'bassline', 'add_effect']],
    // Housekeeping, help and words it cannot read
    ['undo', ['command']],
    ['tidy up the song', ['tidy']],
    ['help', /Without an AI/],
    ['tell me a joke', /connect an AI/],
    ['add a pad', /connect an AI/],
    ['make the melody simpler', /not the melody/],
    ['a house beat at 124', 'none'],
    ['make a sad trap song', 'none'],
    ['boom bap beat with swing', 'none'],
    // More than one thing in one request
    ['busier hats and a new melody for the chorus', ['vary:double_hats', 'write_notes']],
    ['busier hats in the chorus and simpler drums in the verse', ['vary:double_hats', 'vary:thin']],
  ];

  it('has at least sixty phrasings', () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
  });

  it.each(rows)('"%s"', (phrase, expected) => {
    const outcome = interpret(phrase);
    if (expected === 'none') {
      expect(outcome).toEqual({ kind: 'none' });
    } else if (expected instanceof RegExp) {
      expect(outcome.kind).toBe('reply');
      expect((outcome as { text: string }).text).toMatch(expected);
    } else {
      expect(outcome.kind).toBe('edit');
      expect(signature((outcome as { actions: OfflineAction[] }).actions)).toEqual([...expected].sort());
    }
  });
});

describe('the part of the song a request is held to', () => {
  const guards: readonly (readonly [string, BarRange | null])[] = [
    ['busier hats', null],
    ['busier hats in bars 9-16', { fromBar: 9, toBar: 16 }],
    ['busier hats in bars 9 to 16', { fromBar: 9, toBar: 16 }],
    ['busier hats from bar 9 to bar 16', { fromBar: 9, toBar: 16 }],
    ['busier hats in the first 8 bars', { fromBar: 1, toBar: 8 }],
    ['busier hats in the last 12 bars', { fromBar: 50, toBar: 61 }],
    ['busier hats in the first verse', { fromBar: 5, toBar: 12 }],
    ['busier hats in verse 2', { fromBar: 25, toBar: 32 }],
    ['busier hats in the second verse', { fromBar: 25, toBar: 32 }],
    ['busier hats in the last chorus', { fromBar: 49, toBar: 56 }],
    ['busier hats in the hook 2', { fromBar: 37, toBar: 44 }],
    // A chorus the song has three of is all three: no single part to hold the answer to.
    ['busier hats in the chorus', null],
    // A place around a part is not the part.
    ['add a riser into the chorus', null],
    ['add a build before the last chorus', null],
  ];

  it.each(guards)('"%s"', (phrase, expected) => {
    const outcome = interpret(phrase);
    expect(outcome.kind).toBe('edit');
    expect((outcome as { guard: BarRange | null }).guard).toEqual(expected);
  });

  it('applies the part the musician picked to every change, whatever the words say', () => {
    const focus = { range: { fromBar: 5, toBar: 12 }, label: 'Verse · bars 5–12' };
    const outcome = interpret('busier hats', song, focus);
    expect(outcome).toMatchObject({ kind: 'edit', guard: { fromBar: 5, toBar: 12 } });
    const action = (outcome as { actions: OfflineAction[] }).actions[0];
    expect(action).toMatchObject({ op: 'vary', kind: 'double_hats', from_bar: 5, to_bar: 12 });
  });

  it('says which parts there are when the part named is not in the song', () => {
    const outcome = interpret('busier hats in the second bridge');
    expect(outcome.kind).toBe('reply');
    expect((outcome as { text: string }).text).toMatch(/Its parts are Intro \(bars 1–4\), Verse \(bars 5–12\)/);
    const noPart = interpret('busier hats in the interlude');
    expect((noPart as { text: string }).text).toMatch(/no break in this song|no interlude/);
  });

  it('names the part and its bars in what it did', () => {
    const outcome = interpret('simpler drums in the first verse');
    expect((outcome as { message: string }).message).toMatch(/the Verse \(bars 5–12\)/);
  });
});

describe('vocals', () => {
  const withVocal = () => songWithVocal();

  it('makes harmonies from a vocal: the voices the words name, else a third above and a fifth below', () => {
    const project = withVocal();
    const named = interpret('add a third above and a fifth below to the vocal', project) as { actions: OfflineAction[] };
    expect(named.actions).toHaveLength(1);
    expect(named.actions[0]).toMatchObject({ op: 'make_harmonies' });
    expect(field<{ rule: string }[]>(named.actions[0], 'voices').map((voice) => voice.rule)).toEqual(['third_above', 'fifth_below']);
    const plain = interpret('add harmonies to the vocal', project) as { actions: OfflineAction[] };
    expect(field<{ rule: string }[]>(plain.actions[0], 'voices').map((voice) => voice.rule)).toEqual(['third_above', 'fifth_below']);
    const three = interpret('add three harmonies', project) as { actions: OfflineAction[] };
    expect(field<unknown[]>(three.actions[0], 'voices')).toHaveLength(3);
  });

  it('uses fixed distances when the song has no key', () => {
    const project = produce(withVocal(), (draft) => {
      draft.transport.key = undefined;
    });
    const outcome = interpret('add a third above to the vocal', project) as { actions: OfflineAction[] };
    expect(field<{ rule: string; interval: number }[]>(outcome.actions[0], 'voices')[0]).toMatchObject({ rule: 'fixed', interval: 4 });
  });

  it('cleans up a vocal: all of it, or only what is named', () => {
    const project = withVocal();
    const all = interpret('clean up the vocal', project) as { actions: OfflineAction[] };
    expect(all.actions[0]).toMatchObject({ op: 'clean_vocal', noise_db: 12, breaths_db: 10, clicks: true });
    const breaths = interpret('take the breaths down 8 dB on the vocal', project) as { actions: OfflineAction[] };
    expect(breaths.actions[0]).toMatchObject({ op: 'clean_vocal', breaths_db: 8 });
    expect(breaths.actions[0]).not.toHaveProperty('noise_db');
    const clicks = interpret('remove the mouth clicks', project) as { actions: OfflineAction[] };
    expect(clicks.actions[0]).toMatchObject({ op: 'clean_vocal', clicks: true });
    expect(clicks.actions[0]).not.toHaveProperty('noise_db');
    const lot = interpret('remove a lot of the noise from the vocal', project) as { actions: OfflineAction[] };
    expect(lot.actions[0]).toMatchObject({ noise_db: 20 });
  });

  it('works only on the vocal clips inside a part that is named', () => {
    const project = withVocal();
    const inside = interpret('clean up the vocal in bars 17-24', project);
    expect(inside.kind).toBe('edit');
    const outside = interpret('clean up the vocal in bars 1-8', project);
    expect(outside).toMatchObject({ kind: 'reply' });
    expect((outside as { text: string }).text).toMatch(/no recorded vocal in bars 1–8/);
  });

  it('moves a vocal with a key change', () => {
    const outcome = interpret('transpose up 2 semitones', withVocal()) as { actions: OfflineAction[] };
    expect(outcome.actions.some((action) => action.op === 'edit_channel' && action.pitch_cents === 200)).toBe(true);
  });
});

describe('amounts and numbers', () => {
  it('reads "a bit", nothing and "a lot" as three sizes', () => {
    const level = (text: string) => field<number>((interpret(text) as { actions: OfflineAction[] }).actions[0], 'volume_db');
    const small = level('turn the lead up a bit');
    const normal = level('turn the lead up');
    const large = level('turn the lead up a lot');
    expect(normal - small).toBeCloseTo(1.5, 5);
    expect(large - normal).toBeCloseTo(3, 5);
  });

  it('reads dB, with and without a sign', () => {
    const level = (text: string) => field<number>((interpret(text) as { actions: OfflineAction[] }).actions[0], 'volume_db');
    const base = level('turn the lead up 0 db');
    expect(level('turn the lead up 4 db') - base).toBeCloseTo(4, 5);
    expect(level('turn the lead +2 db') - base).toBeCloseTo(2, 5);
    expect(level('turn the lead down 3 db') - base).toBeCloseTo(-3, 5);
    expect(level('turn the lead -5 db') - base).toBeCloseTo(-5, 5);
  });

  it('reads written-out numbers', () => {
    const outcome = interpret('transpose up two semitones') as { actions: OfflineAction[] };
    expect(outcome.actions.some((action) => action.op === 'note_tool' && JSON.stringify(action.params).includes('"value":2'))).toBe(true);
    expect(interpret('busier hats in bars nine to sixteen')).toMatchObject({ kind: 'edit', guard: null });
  });
});

describe('the song key, the tempo and the chords', () => {
  it('moves every chord on the chord track by the same number of semitones', () => {
    const outcome = interpret('transpose up 2 semitones') as { actions: OfflineAction[] };
    const set = outcome.actions.find((action) => action.op === 'chords');
    // The song is in G# minor (i, VI): up two it is A# minor (Bbm) with Gb.
    expect(set).toMatchObject({ action: 'set', bars_per_chord: 1, from_bar: 1 });
    expect(String(set?.text)).toMatch(/^Bbm \| \. \| Gb/);
    expect(outcome.actions[0]).toEqual({ op: 'song', key: 'Bb minor' });
  });

  it('moves the notes of pitched parts only, never the drums', () => {
    const outcome = interpret('transpose up 2 semitones') as { actions: OfflineAction[] };
    const roles = rolesOf(song);
    const moved = outcome.actions.filter((action) => action.op === 'note_tool');
    expect(moved.length).toBeGreaterThan(5);
    for (const action of moved) expect(['pad', 'lead', '808', 'arp', 'bass', 'keys', 'chords', 'pluck']).toContain(roles.get(action.channel as never));
  });

  it('goes the short way round to another key', () => {
    const up = interpret('change the key to b minor') as { actions: OfflineAction[] };
    expect(JSON.stringify(up.actions.find((action) => action.op === 'note_tool')?.params)).toContain('"value":3');
    const down = interpret('change the key to d minor') as { actions: OfflineAction[] };
    expect(JSON.stringify(down.actions.find((action) => action.op === 'note_tool')?.params)).toContain('"value":-6');
  });

  it('chooses a progression of the palette that is not the one playing', () => {
    const outcome = interpret('change the chords in bars 9-16') as { actions: OfflineAction[] };
    expect(outcome.actions[0]).toMatchObject({ op: 'chords', action: 'progression', from_bar: 9, bars: 8 });
    const sevenths = interpret('use seventh chords in bars 9-16') as { actions: OfflineAction[] };
    expect(sevenths.actions[0]).toMatchObject({ sevenths: true });
  });
});

describe('determinism and variation', () => {
  it('gives the same actions for the same words, project and edit count', () => {
    const phrase = 'write a new melody for the chorus';
    expect(interpret(phrase)).toEqual(interpret(phrase));
    const changed = interpretEdit({ text: phrase, project: song, roles: rolesOf(song), focus: null, variation: 1 });
    expect(changed).not.toEqual(interpret(phrase));
  });

  it('gives another melody when the same one is asked for again', () => {
    const notesOf = (variation: number) =>
      JSON.stringify(
        (interpretEdit({ text: 'write a new hook', project: song, roles: rolesOf(song), focus: null, variation }) as { actions: OfflineAction[] }).actions.map(
          (action) => action.notes,
        ),
      );
    expect(notesOf(0)).toBe(notesOf(0));
    expect(notesOf(0)).not.toBe(notesOf(1));
  });
});

describe('an empty playlist', () => {
  it('says there is no song to change, and still sets a tempo', () => {
    const empty = createEmptyProject();
    const roles = new Map();
    const hats = interpretEdit({ text: 'busier hats', project: empty, roles, focus: null, variation: 0 });
    expect(hats).toMatchObject({ kind: 'reply' });
    expect((hats as { text: string }).text).toMatch(/playlist is empty/);
    const tempo = interpretEdit({ text: 'tempo 100', project: empty, roles, focus: null, variation: 0 });
    expect(tempo).toMatchObject({ kind: 'edit', actions: [{ op: 'song', bpm: 100 }] });
    void makeInstrumentChannel;
    void makePluginInstance;
  });
});
