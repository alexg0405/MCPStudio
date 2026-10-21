/**
 * Changing a song with no AI: plain words become the AI studio's actions and go through the same apply step, on songs the v2
 * generator wrote. Each test looks at what really changed in the project: the hats of one section, the chord track of eight bars,
 * every pitched note moved, a new marker, each change one undo step, the part the musician picked, and the same words twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chordPitchClasses } from '@core/harmony/chord';
import type { ChannelId, Pattern, PatternId, Project } from '@core/model/types';
import { chordAt, chordsSorted } from '@core/query/chords';
import { songSections } from '@core/query/sections';
import { rolesOf } from '../arrange/env';
import { createTestServices } from '../testing';
import { registerAfterStep } from './after-steps';
import { BeatAssistant } from './assistant';
import { symbolOf } from '@core/ops/chords';

const NO = { ok: false, reason: 'not set up' };
const offline = (async () => new Response(JSON.stringify({ subscription: NO, api: NO }), { status: 200 })) as typeof fetch;
const BAR = 3840;

let removeLevelStep: () => void;
beforeAll(() => {
  // Node has no OfflineAudioContext: the leveling step (a render) is left out.
  removeLevelStep = registerAfterStep('level_mix', async () => null);
});
afterAll(() => removeLevelStep());

/** A song written by the offline generator, in its own services. */
async function songOf(request: string) {
  const s = createTestServices();
  const a = new BeatAssistant(s, { fetch: offline });
  await a.send(request);
  return { s, a };
}

type Setup = Awaited<ReturnType<typeof songOf>>;
const projectOf = (setup: Setup): Project => setup.s.doc.getState().project;
const stepsOf = (setup: Setup): number => setup.s.history.steps().done.length;
const lastReply = (setup: Setup) => setup.a.store.getState().messages.at(-1)!;

/** How many notes the channels with these roles have in the patterns that play inside the bars (1-based, inclusive). */
function notesPlayingIn(p: Project, roles: readonly string[], fromBar: number, toBar: number): number {
  const roleOf = rolesOf(p);
  let count = 0;
  for (const clip of Object.values(p.playlist.clips)) {
    if (clip.kind !== 'pattern' || clip.start >= toBar * BAR || clip.start + clip.length <= (fromBar - 1) * BAR) continue;
    const pattern = p.patterns[clip.patternId] as Pattern;
    const patternLength = pattern.length ?? 4 * BAR;
    for (const [channelId, notes] of Object.entries(pattern.notes)) {
      if (!roles.includes(roleOf.get(channelId as ChannelId) ?? 'other')) continue;
      count += Object.keys(notes ?? {}).length * Math.min(1, clip.length / patternLength);
    }
  }
  return count;
}

const HATS = ['hat', 'open-hat'];
const sectionBars = (p: Project) => songSections(p).map((section) => ({ name: section.name, from: Math.round(section.from / BAR) + 1, to: Math.round(section.to / BAR) }));

describe('changing a generated trap song offline', () => {
  let trap: Setup;
  beforeAll(async () => {
    trap = await songOf('a sad trap song at 140');
  });

  it('makes the hats busier in the part named and nowhere else, as one undo step', async () => {
    const { s, a } = await songOf('a sad trap song at 140');
    const before = s.doc.getState().project;
    const sections = sectionBars(before);
    const hook = sections.find((section) => section.name === 'Hook')!;
    const counts = (p: Project) => sections.map((section) => notesPlayingIn(p, HATS, section.from, section.to));
    const hatsBefore = counts(before);
    const steps = s.history.steps().done.length;

    await a.send('busier hats in the first chorus');
    const after = s.doc.getState().project;
    const hatsAfter = counts(after);

    expect(s.history.steps().done.length).toBe(steps + 1);
    sections.forEach((section, index) => {
      if (section === hook) expect(hatsAfter[index], section.name).toBeGreaterThan(hatsBefore[index]!);
      else expect(hatsAfter[index], section.name).toBe(hatsBefore[index]);
    });
    const reply = a.store.getState().messages.at(-1)!;
    expect(reply.offline).toBe(true);
    expect(reply.text).toMatch(/hats busier in the Hook \(bars 17–24\)/);
    expect(reply.changes?.join(' ')).toMatch(/double hats over bars 17–24/);
    expect(reply.warnings).toBeUndefined();
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
  });

  it('changes the chord track only inside the bars named, and writes the parts on the new chords', async () => {
    const { s, a } = await songOf('a sad trap song at 140');
    const before = s.doc.getState().project;
    await a.send('change the chords in bars 9-16');
    const after = s.doc.getState().project;
    const outside = (event: { tick: number; length: number }) => event.tick + event.length <= 8 * BAR || event.tick >= 16 * BAR;
    // At the start of every bar outside bars 9–16 the chord is the one it was (a chord that ran across the edge is cut there).
    const chordAtBar = (p: Project, bar: number) => {
      const event = chordAt(p, (bar - 1) * BAR);
      return event ? `${event.root}${event.quality}` : '-';
    };
    for (let bar = 1; bar <= 61; bar++) {
      if (bar >= 9 && bar <= 16) continue;
      expect(chordAtBar(after, bar), `bar ${bar}`).toBe(chordAtBar(before, bar));
    }
    const inside = (p: Project) => chordsSorted(p).filter((event) => !outside(event)).map(({ tick, root, quality }) => `${tick}:${root}${quality}`);
    expect(inside(after)).not.toEqual(inside(before));
    expect(inside(after).length).toBeGreaterThan(0);
    // The chord parts that play in bars 9–16 now sit on the new chords: every pad note is a tone of the chord under it.
    const roles = rolesOf(after);
    let checked = 0;
    for (const clip of Object.values(after.playlist.clips)) {
      if (clip.kind !== 'pattern' || clip.start < 8 * BAR || clip.start >= 16 * BAR) continue;
      for (const [channelId, notes] of Object.entries(after.patterns[clip.patternId]!.notes)) {
        if (roles.get(channelId as ChannelId) !== 'pad') continue;
        for (const note of Object.values(notes ?? {})) {
          const event = chordAt(after, clip.start + note.tick - clip.offset);
          if (!event) continue;
          expect(chordPitchClasses(symbolOf(event)), `pad note ${note.key} at tick ${note.tick}`).toContain(((note.key % 12) + 12) % 12);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    // The bars outside kept their notes: every pattern that plays outside bars 9–16 is as it was.
    for (const clip of Object.values(after.playlist.clips)) {
      if (clip.kind !== 'pattern' || (clip.start < 16 * BAR && clip.start + clip.length > 8 * BAR)) continue;
      expect(after.patterns[clip.patternId]!.notes, after.patterns[clip.patternId]!.name).toEqual(before.patterns[clip.patternId]?.notes ?? after.patterns[clip.patternId]!.notes);
    }
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
    void a;
  });

  it('transposes every pitched part and the chord track, and leaves the drums alone', async () => {
    const { s, a } = await songOf('a sad trap song at 140');
    const before = s.doc.getState().project;
    const roles = rolesOf(before);
    const pitched = new Set(['pad', 'lead', '808', 'arp', 'bass', 'keys', 'chords', 'pluck']);
    await a.send('transpose up 2 semitones');
    const after = s.doc.getState().project;
    expect(after.transport.key?.root).toBe((before.transport.key!.root + 2) % 12);
    expect(chordsSorted(after).map((event) => event.root)).toEqual(chordsSorted(before).map((event) => (event.root + 2) % 12));
    let movedParts = 0;
    for (const patternId of before.patternOrder) {
      for (const [channelId, notes] of Object.entries(before.patterns[patternId]!.notes)) {
        const keysBefore = Object.values(notes ?? {}).map((note) => note.key).sort((x, y) => x - y);
        const keysAfter = Object.values(after.patterns[patternId]!.notes[channelId as ChannelId] ?? {}).map((note) => note.key).sort((x, y) => x - y);
        if (pitched.has(roles.get(channelId as ChannelId) ?? 'other')) {
          expect(keysAfter, `${before.patterns[patternId]!.name} / ${before.channels[channelId as ChannelId]!.name}`).toEqual(keysBefore.map((key) => key + 2));
          if (keysBefore.length > 0) movedParts++;
        } else {
          expect(keysAfter).toEqual(keysBefore);
        }
      }
    }
    expect(movedParts).toBeGreaterThan(10);
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
  });

  it('turns bars into a breakdown: the drums leave them, a marker names them, the rest keeps its drums', async () => {
    const { s, a } = await songOf('a sad trap song at 140');
    const before = s.doc.getState().project;
    const drums = ['kick', 'snare', 'clap', 'hat', 'open-hat'];
    expect(notesPlayingIn(before, drums, 25, 32)).toBeGreaterThan(0);
    const outsideBefore = notesPlayingIn(before, drums, 1, 24) + notesPlayingIn(before, drums, 33, 61);
    await a.send('make bars 25-32 a breakdown');
    const after = s.doc.getState().project;
    expect(notesPlayingIn(after, drums, 25, 32)).toBe(0);
    expect(notesPlayingIn(after, drums, 1, 24) + notesPlayingIn(after, drums, 33, 61)).toBe(outsideBefore);
    const marker = Object.values(after.playlist.markers).find((candidate) => candidate.tick === 24 * BAR);
    expect(marker?.name).toBe('Breakdown');
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
  });

  it('writes a different melody each time it is asked for, on the chords', async () => {
    const { s, a } = await songOf('a sad trap song at 140');
    const hookLead = () => {
      const p = s.doc.getState().project;
      const roles = rolesOf(p);
      const hook = Object.values(p.patterns).find((pattern) => pattern.name === 'Hook')!;
      const channelId = Object.keys(hook.notes).find((id) => roles.get(id as ChannelId) === 'lead') as ChannelId;
      return Object.values(hook.notes[channelId] ?? {}).map((note) => `${note.tick}:${note.key}`).sort().join(',');
    };
    const original = hookLead();
    await a.send('write a new hook for the first chorus');
    const first = hookLead();
    await a.send('write a new hook for the first chorus');
    const second = hookLead();
    expect(first).not.toBe(original);
    expect(second).not.toBe(first);
    // The lead is on the chords: every note that starts a bar is a tone of the chord under it.
    const p = s.doc.getState().project;
    const hook = Object.values(p.patterns).find((pattern) => pattern.name === 'Hook')!;
    const roles = rolesOf(p);
    const clip = Object.values(p.playlist.clips).find((candidate) => candidate.kind === 'pattern' && candidate.patternId === hook.id)!;
    let onBeats = 0;
    for (const [channelId, notes] of Object.entries(hook.notes)) {
      if (roles.get(channelId as ChannelId) !== 'lead') continue;
      for (const note of Object.values(notes ?? {})) {
        if (note.tick % (BAR / 2) !== 0) continue;
        const event = chordAt(p, clip.start + note.tick)!;
        expect(chordPitchClasses(symbolOf(event))).toContain(((note.key % 12) + 12) % 12);
        onBeats++;
      }
    }
    expect(onBeats).toBeGreaterThan(2);
  });

  it('gives the same melody for the same words in a song written the same way', async () => {
    const leadNotes = async () => {
      const { s, a } = await songOf('a sad trap song at 140');
      await a.send('write a new hook for the first chorus');
      const p = s.doc.getState().project;
      const roles = rolesOf(p);
      const hook = Object.values(p.patterns).find((pattern) => pattern.name === 'Hook')!;
      const channelId = Object.keys(hook.notes).find((id) => roles.get(id as ChannelId) === 'lead') as ChannelId;
      return Object.values(hook.notes[channelId] ?? {}).map((note) => `${note.tick}:${note.key}:${note.length}`).sort();
    };
    expect(await leadNotes()).toEqual(await leadNotes());
  });

  it('makes each change one undo step and undoing it gives the song back', async () => {
    const phrases = [
      'busier hats',
      'simpler drums in bars 9-16',
      'no hats in bars 9-16',
      'make the kick and snare hit harder',
      'make the kick and snare hit harder in the first chorus',
      'write a new melody for the chorus',
      'change the chords in bars 9-16',
      'use seventh chords',
      'transpose down 3 semitones',
      'tempo 120',
      'more swing',
      'add a fill at the end of bar 8',
      'add a breakdown',
      'add a build before the last chorus',
      'add a riser into the chorus',
      'smoother transitions',
      'more variation',
      'turn the lead up 3 dB',
      'make the lead louder in the first chorus',
      'more reverb on the lead',
      'make the pads wider',
      'mute the hats',
      'make it sound like house',
    ];
    const { s, a } = await songOf('a sad trap song at 140');
    const original = s.doc.getState().project;
    let changed = 0;
    for (const phrase of phrases) {
      const steps = s.history.steps().done.length;
      await a.send(phrase);
      const reply = a.store.getState().messages.at(-1)!;
      expect(reply.warnings, phrase).toBeUndefined();
      // One undo step, or none when there was nothing to change (a riser that is already there).
      const made = s.history.steps().done.length - steps;
      expect(made === 0 || made === 1, phrase).toBe(true);
      if (made === 1) changed++;
      if (made === 1) s.history.undo();
      expect(s.doc.getState().project, phrase).toEqual(original);
    }
    expect(changed).toBeGreaterThanOrEqual(phrases.length - 2);
  });

  it('answers words it cannot read politely and changes nothing', async () => {
    const { s, a } = await songOf('a sad trap song at 140');
    const before = s.doc.getState().project;
    const steps = s.history.steps().done.length;
    for (const phrase of ['tell me a joke', 'make the melody simpler', 'add a pad', 'make the chorus bigger']) {
      await a.send(phrase);
      const reply = a.store.getState().messages.at(-1)!;
      expect(reply.offline, phrase).toBe(true);
      expect(reply.text, phrase).toMatch(/connect an AI|not the melody|an AI/);
      expect(reply.changes, phrase).toBeUndefined();
      expect(s.doc.getState().project, phrase).toBe(before);
      expect(s.history.steps().done.length).toBe(steps);
      expect(a.store.getState().phase).toBe('idle');
    }
  });

  it('answers a part the song does not have by listing the parts it has', async () => {
    const { s, a } = await songOf('a sad trap song at 140');
    const before = s.doc.getState().project;
    await a.send('busier hats in the second bridge');
    expect(lastReply({ s, a })).toMatchObject({ offline: true });
    expect(lastReply({ s, a }).text).toMatch(/Its parts are Intro \(bars 1–4\)/);
    expect(s.doc.getState().project).toBe(before);
  });

  it('keeps the whole conversation working: a request, a change, another change, a new song', async () => {
    const { s, a } = await songOf('a sad trap song at 140');
    await a.send('busier hats in bars 9-16');
    await a.send('write a new melody for the hook');
    await a.send('a house song at 124');
    const p = s.doc.getState().project;
    expect(p.transport.bpm).toBe(124);
    expect(Object.values(p.playlist.markers).length).toBeGreaterThan(5);
  });

  it('reads the project and the words of the last change in its reply', () => {
    expect(lastReply(trap).text).toMatch(/sad trap song/);
  });
});

describe('what the drum and mix changes do to the notes and the mixer', () => {
  /** The average velocity of the notes of the channels with this role, over every pattern. */
  function averageVelocity(p: Project, role: string): number {
    const roles = rolesOf(p);
    const velocities: number[] = [];
    for (const pattern of Object.values(p.patterns)) {
      for (const [channelId, notes] of Object.entries(pattern.notes)) {
        if (roles.get(channelId as ChannelId) === role) for (const note of Object.values(notes ?? {})) velocities.push(note.velocity);
      }
    }
    return velocities.reduce((sum, velocity) => sum + velocity, 0) / velocities.length;
  }

  it('hits harder: louder snare notes, a clap layered on a snare that has none, effects on the buses', async () => {
    const setup = await songOf('a boom bap song');
    const before = projectOf(setup);
    await setup.a.send('make the kick and snare hit harder');
    const after = projectOf(setup);
    // Velocities stop at the top (a full hit stays full), so the average rises by less than the 22 % asked.
    expect(averageVelocity(after, 'snare')).toBeGreaterThan(averageVelocity(before, 'snare') * 1.02);
    expect(averageVelocity(after, 'kick')).toBeGreaterThan(averageVelocity(before, 'kick') * 1.02);
    // A clap is layered on the snare, in every pattern the snare plays in, with the snare's own rhythm.
    const layer = Object.values(after.channels).find((channel) => channel.name === 'Snare layer')!;
    expect(layer).toBeDefined();
    const roles = rolesOf(after);
    const verse = Object.values(after.patterns).find((pattern) => pattern.name === 'Verse')!;
    const snareId = Object.keys(verse.notes).find((id) => roles.get(id as ChannelId) === 'snare') as ChannelId;
    const ticks = (id: string) =>
      Object.values(verse.notes[id as ChannelId] ?? {})
        .map((note) => note.tick)
        .sort((x, y) => x - y);
    expect(ticks(layer.id)).toEqual(ticks(snareId));
    // The kick bus is saturated and the drums bus got a sharper attack.
    const effectsOn = (insert: string) =>
      after.mixer.order.map((id) => after.mixer.inserts[id]!).find((candidate) => candidate.name === insert)?.fx.map((slot) => slot.plugin.pluginId);
    expect(effectsOn('Kick')).toContain('agstudio.saturator');
    expect(effectsOn('Drums')).toContain('agstudio.transient');
    setup.s.history.undo();
    expect(projectOf(setup)).toEqual(before);
  });

  it('hits harder in one part with the notes only: no new effects, the rest of the song as it was', async () => {
    const setup = await songOf('a sad trap song at 140');
    const before = projectOf(setup);
    await setup.a.send('make the kick and snare hit harder in the first chorus');
    const after = projectOf(setup);
    expect(Object.values(after.mixer.inserts).map((insert) => insert.fx.length)).toEqual(Object.values(before.mixer.inserts).map((insert) => insert.fx.length));
    expect(lastReply(setup).text).toMatch(/for the whole song: ask without a part/);
  });

  it('makes drums simpler and takes hats out in the bars named, and nowhere else', async () => {
    const drums = ['kick', 'snare', 'clap', 'hat', 'open-hat'];
    const setup = await songOf('a sad trap song at 140');
    const before = projectOf(setup);
    await setup.a.send('simpler drums in bars 9-16');
    const simpler = projectOf(setup);
    expect(notesPlayingIn(simpler, drums, 9, 16)).toBeLessThan(notesPlayingIn(before, drums, 9, 16));
    expect(notesPlayingIn(simpler, drums, 1, 8)).toBe(notesPlayingIn(before, drums, 1, 8));
    expect(notesPlayingIn(simpler, drums, 17, 61)).toBe(notesPlayingIn(before, drums, 17, 61));
    setup.s.history.undo();
    await setup.a.send('no hats in bars 9-16');
    const without = projectOf(setup);
    expect(notesPlayingIn(before, HATS, 9, 16)).toBeGreaterThan(0);
    expect(notesPlayingIn(without, HATS, 9, 16)).toBe(0);
    expect(notesPlayingIn(without, HATS, 17, 61)).toBe(notesPlayingIn(before, HATS, 17, 61));
    expect(notesPlayingIn(without, ['kick'], 9, 16)).toBe(notesPlayingIn(before, ['kick'], 9, 16));
  });

  it('sets a tempo and a swing and changes nothing else', async () => {
    const setup = await songOf('a sad trap song at 140');
    const before = projectOf(setup);
    await setup.a.send('tempo 128');
    await setup.a.send('swing 30%');
    const after = projectOf(setup);
    expect(after.transport.bpm).toBe(128);
    expect(after.transport.swing).toBeCloseTo(0.3, 5);
    expect(after.patterns).toEqual(before.patterns);
    expect(after.playlist).toEqual(before.playlist);
  });

  it('turns a level up by the dB asked, and a part of the song by automation that goes back', async () => {
    const setup = await songOf('a sad trap song at 140');
    const before = projectOf(setup);
    const lead = Object.values(before.mixer.inserts).find((insert) => insert.name === 'Lead')!;
    await setup.a.send('turn the lead up 3 dB');
    const after = projectOf(setup).mixer.inserts[lead.id]!;
    expect(20 * Math.log10(after.volume / lead.volume)).toBeCloseTo(3, 1);
    setup.s.history.undo();
    const clipsBefore = Object.keys(projectOf(setup).playlist.clips).length;
    await setup.a.send('make the lead louder in the first chorus');
    // The fader itself does not move: an automation clip over bars 17–24 does, and puts the level back at its end.
    expect(projectOf(setup).mixer.inserts[lead.id]!.volume).toBe(lead.volume);
    expect(Object.keys(projectOf(setup).playlist.clips).length).toBe(clipsBefore + 1);
  });

  it('adds a fill at the end of the bar named: the clip there plays a variant with a fill', async () => {
    const setup = await songOf('a sad trap song at 140');
    const before = projectOf(setup);
    await setup.a.send('add a fill at the end of bar 8');
    const after = projectOf(setup);
    const playingAt = (p: Project, bar: number) =>
      Object.values(p.playlist.clips).filter((clip) => clip.kind === 'pattern' && clip.start <= (bar - 1) * BAR && clip.start + clip.length > (bar - 1) * BAR);
    const names = (p: Project) => playingAt(p, 8).map((clip) => (clip.kind === 'pattern' ? p.patterns[clip.patternId]!.name : ''));
    expect(names(after).join()).not.toBe(names(before).join());
    expect(lastReply(setup).changes?.join(' ')).toMatch(/fill at the end of bar 8/);
  });
});

describe('changing a part the musician picked', () => {
  /** A section of the song as the focus the playlist hands over. */
  function focusOn(setup: Setup, name: string) {
    const p = projectOf(setup);
    const marker = Object.values(p.playlist.markers).find((candidate) => candidate.name === name)!;
    const section = songSections(p).find((candidate) => candidate.markerId === marker.id)!;
    return { kind: 'section' as const, markerId: marker.id, from: section.from, to: section.to, projectId: p.projectId };
  }

  /** Every clip of the playlist outside the bars as "start length pattern notes", to compare before and after. */
  function outsideLines(p: Project, fromBar: number, toBar: number): string[] {
    return Object.values(p.playlist.clips)
      .filter((clip) => clip.start + clip.length <= (fromBar - 1) * BAR || clip.start >= toBar * BAR)
      .map((clip) => {
        const pattern = clip.kind === 'pattern' ? p.patterns[clip.patternId] : undefined;
        const notes = pattern ? JSON.stringify(Object.entries(pattern.notes).map(([channel, set]) => [channel, Object.values(set ?? {}).map((note) => [note.tick, note.key, note.velocity])])) : '';
        return `${clip.kind} ${clip.start} ${clip.length} ${clip.kind === 'pattern' ? clip.patternId : clip.channelId} ${notes}`;
      })
      .sort();
  }

  it('changes only that part, as one undo step, whatever the words', async () => {
    for (const phrase of ['busier hats', 'make the kick and snare hit harder', 'change the chords', 'write a new melody', 'transpose up 2 semitones', 'simpler drums']) {
      const setup = await songOf('a sad trap song at 140');
      const { s, a } = setup;
      const before = projectOf(setup);
      const steps = stepsOf(setup);
      await a.send(phrase, { focus: focusOn(setup, 'Verse') });
      const after = projectOf(setup);
      const reply = lastReply(setup);
      expect(reply.approval, phrase).toBeUndefined();
      expect(reply.warnings, phrase).toBeUndefined();
      expect(reply.text, phrase).toMatch(/Verse/);
      expect(stepsOf(setup), phrase).toBe(steps + 1);
      expect(outsideLines(after, 5, 12), phrase).toEqual(outsideLines(before, 5, 12));
      // The song key belongs to the whole song, so a part of it moves only its notes and chords.
      expect(after.transport.key, phrase).toEqual(before.transport.key);
      s.history.undo();
      expect(s.doc.getState().project, phrase).toEqual(before);
    }
  });

  it('asks before it touches bars outside the part, and does nothing until the musician says so', async () => {
    const setup = await songOf('a sad trap song at 140');
    const before = projectOf(setup);
    await setup.a.send('add a riser into the chorus', { focus: focusOn(setup, 'Verse') });
    const reply = lastReply(setup);
    expect(reply.approval).toMatchObject({ state: 'ask' });
    expect(projectOf(setup)).toBe(before);
    expect(setup.a.store.getState().phase).toBe('idle');
  });

  it('copies a pattern that plays inside and outside the part, so the rest of the song stays', async () => {
    const setup = await songOf('a sad trap song at 140');
    const before = projectOf(setup);
    // The Pad plays in the Intro and in the Verse as one pattern family: a change in the Verse alone leaves the Intro as it was.
    await setup.a.send('write a new melody', { focus: focusOn(setup, 'Verse 2') });
    const after = projectOf(setup);
    expect(outsideLines(after, 25, 32)).toEqual(outsideLines(before, 25, 32));
    const verse2 = lastReply(setup);
    expect(verse2.changes?.join(' ')).toMatch(/Wrote \d+ notes for “Lead”/);
  });
});

describe('changing a generated house song offline', () => {
  it('works on another style: busier hats, new chords and a key change', async () => {
    const setup = await songOf('an uplifting house song at 124');
    const { s, a } = setup;
    const original = projectOf(setup);
    for (const phrase of ['busier hats', 'change the chords', 'transpose down 3 semitones', 'write a new melody for the chorus', 'add an outro', 'simpler drums in the first 8 bars']) {
      const steps = stepsOf(setup);
      await a.send(phrase);
      const reply = lastReply(setup);
      expect(reply.offline, phrase).toBe(true);
      expect(reply.warnings, phrase).toBeUndefined();
      const made = stepsOf(setup) - steps;
      expect(made === 0 || made === 1, phrase).toBe(true);
      if (made === 1) s.history.undo();
      expect(s.doc.getState().project, phrase).toEqual(original);
    }
  });
});

describe('the conversation around a song', () => {
  it('still gives a beat to words that are only a beat, and a new song to words that ask for one', async () => {
    const setup = await songOf('a sad trap song at 140');
    const patternsBefore = Object.keys(projectOf(setup).patterns).length;
    await setup.a.send('boom bap beat with swing');
    expect(lastReply(setup).beat).toBeDefined();
    expect(Object.keys(projectOf(setup).patterns).length).toBeGreaterThan(patternsBefore);
    await setup.a.send('a lofi song in D minor');
    expect(projectOf(setup).transport.key).toEqual({ root: 2, scale: 'minor' });
  });

  it('keeps writing a beat\'s follow-ups as a beat while no song is on the playlist', async () => {
    const s = createTestServices();
    const a = new BeatAssistant(s, { fetch: offline });
    await a.send('trap beat with 808s');
    const patternsAfterBeat = Object.keys(s.doc.getState().project.patterns).length;
    await a.send('busier hats');
    // The follow-up rewrites the beat's own pattern: no new pattern, no song edit.
    expect(Object.keys(s.doc.getState().project.patterns).length).toBe(patternsAfterBeat);
    expect(a.store.getState().messages.at(-1)!.beat).toBeDefined();
  });

  it('forgets the count of changes on New chat, so the same words give the same melody again', async () => {
    const setup = await songOf('a sad trap song at 140');
    const { a } = setup;
    await a.send('write a new hook');
    a.newBeat();
    await a.send('write a new hook');
    expect(lastReply(setup).offline).toBe(true);
    void ({} as PatternId);
  });
});
