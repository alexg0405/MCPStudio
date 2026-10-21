/** A channel's MIDI effects in the schedule: the events the transport collects, and what it sends while playing and after an edit. */
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { seededBytes, setIdSource } from '@core/model/ids';
import type { ChannelId, ClipId, LaneId, MidiFxSlotId, NoteId, PatternId, Project } from '@core/model/types';
import { midiFxOf } from '@core/query/midi-fx';
import { addChannel } from '@core/ops/channels';
import { setChord } from '@core/ops/chords';
import { addMidiFx, setMidiFxEnabled, setMidiFxParam } from '@core/ops/midi-fx';
import { addNote } from '@core/ops/notes';
import { addClips } from '@core/ops/playlist';
import { parseChord } from '@core/harmony/chord';
import { constantTempo } from '@core/time/ppq';
import { collectNotes, patternModeSource, songModeSource, type NoteEvent } from './events';
import { Transport, type TransportSink } from './transport';

const STEP = 240;
const BAR = 3840;

interface Rig {
  project: Project;
  patternId: PatternId;
  channelId: ChannelId;
}

/** A project with one channel holding a C major chord for one bar (and its arpeggiator on, when `chain` says so). */
function rig(chain: (draft: Parameters<typeof addMidiFx>[0], channelId: ChannelId) => void = (draft, channelId) => void addMidiFx(draft, channelId, 'arp')): Rig {
  setIdSource(seededBytes(3));
  const channel = makeInstrumentChannel('Keys', makePluginInstance('x', 1, {}));
  const base = createEmptyProject();
  const patternId = base.patternOrder[0] as PatternId;
  const project = produce(base, (draft) => {
    draft.transport.bpm = 120;
    addChannel(draft, channel);
    [60, 64, 67].forEach((key, i) => addNote(draft, patternId, channel.id, { id: `n_${i}` as NoteId, tick: 0, length: BAR, key, velocity: 0.8 }));
    chain(draft, channel.id);
  });
  return { project, patternId, channelId: channel.id };
}

/** The id of the first effect of a channel's chain. */
function firstSlot(project: Pick<Project, 'channels'>, channelId: ChannelId): MidiFxSlotId {
  return midiFxOf(project.channels[channelId])[0]!.id;
}

function events(project: Project, patternId: PatternId, from = 0, to = BAR): NoteEvent[] {
  const out: NoteEvent[] = [];
  collectNotes(patternModeSource(project, patternId).source, from, to, out);
  return out;
}

describe('collecting notes through a channel’s MIDI effects', () => {
  it('plays an arpeggio on the grid in place of the held chord', () => {
    const { project, patternId } = rig();
    const out = events(project, patternId);
    expect(out).toHaveLength(16);
    expect(out.map((e) => e.start)).toEqual(Array.from({ length: 16 }, (_, i) => i * STEP));
    expect(out.slice(0, 4).map((e) => e.pitch)).toEqual([60, 64, 67, 60]);
    // Each carries the id the chain gave it and no pattern note id: it is not a note of the pattern.
    expect(out.every((e) => e.noteId === null && typeof e.fx === 'string' && e.kind === 'note')).toBe(true);
    // The pattern's own notes are untouched.
    expect(Object.keys(project.patterns[patternId]!.notes[Object.keys(project.channels)[0] as ChannelId]!)).toHaveLength(3);
  });

  it('a channel with no chain, or a bypassed one, is collected as it always was', () => {
    const plain = rig(() => {});
    const bypassed = rig((draft, channelId) => {
      setMidiFxEnabled(draft, channelId, addMidiFx(draft, channelId, 'arp')!, false);
    });
    expect(events(plain.project, plain.patternId).map((e) => e.noteId)).toEqual(['n_0', 'n_1', 'n_2']);
    expect(events(bypassed.project, bypassed.patternId).map((e) => e.noteId)).toEqual(['n_0', 'n_1', 'n_2']);
  });

  it('gives the same events however the span is cut into windows (what the transport does as it plans ahead)', () => {
    const { project, patternId } = rig((draft, channelId) => {
      addMidiFx(draft, channelId, 'arp', { params: { pattern: 'random', octaves: 2, swing: 0.4 } });
      addMidiFx(draft, channelId, 'humanize', { params: { timing: 12, seed: 3 } });
    });
    const whole = events(project, patternId);
    const cuts = [0, 97, 120, 121, 1500, 1500.5, 2999, BAR];
    const pieces = cuts.slice(1).flatMap((to, i) => events(project, patternId, cuts[i]!, to));
    expect(pieces.map((e) => [e.key, e.start, e.end, e.pitch, e.velocity])).toEqual(whole.map((e) => [e.key, e.start, e.end, e.pitch, e.velocity]));
  });

  it('the project’s swing is applied after the effects, to generated notes like any other', () => {
    const { project, patternId } = rig();
    const swung = produce(project, (draft) => void (draft.transport.swing = 1));
    const out = events(swung, patternId);
    // Every second 1/16 plays late by half a step, like a drum hit would.
    expect(out.slice(0, 4).map((e) => e.start)).toEqual([0, 360, 480, 840]);
    expect(out.slice(0, 4).map((e) => e.rawStart)).toEqual([0, 240, 480, 720]);
  });

  it('repeats in every repetition of a pattern clip, and follows the chord track where the clip sits', () => {
    const { project, patternId, channelId } = rig((draft, id) => void addMidiFx(draft, id, 'chord', { params: { source: 'chordTrack' } }));
    const lane = project.playlist.laneOrder[0] as LaneId;
    const song = produce(project, (draft) => {
      addClips(draft, [
        { kind: 'pattern', id: 'c1' as ClipId, laneId: lane, start: 0, length: BAR * 2, patternId, offset: 0 },
        { kind: 'pattern', id: 'c2' as ClipId, laneId: lane, start: BAR * 4, length: BAR, patternId, offset: 0 },
      ]);
      setChord(draft, 0, BAR, parseChord('Am')!);
      setChord(draft, BAR, BAR * 4, parseChord('G')!);
    });
    const out: NoteEvent[] = [];
    collectNotes(songModeSource(song).source, 0, BAR * 6, out);
    const chordAtBar = (bar: number) => out.filter((e) => e.start === bar * BAR && e.channelId === channelId).map((e) => e.pitch);
    // Every note of the held chord asks the chord track: three notes in, three chords out (deduplicated per note).
    expect(chordAtBar(0)).toContain(57);
    expect(chordAtBar(1)).toContain(55);
    expect(chordAtBar(4)).toContain(55);
  });

  it('keeps its result while nothing it depends on changes, and makes it again when the chain does', () => {
    const { project, patternId, channelId } = rig();
    const first = events(project, patternId);
    const again = events(project, patternId);
    expect(again[0]).toBe(first[0]);
    const other = produce(project, (draft) => void (draft.meta.title = 'Another title'));
    expect(events(other, patternId)[0]).toBe(first[0]);
    // A different tempo is something the effects can depend on (they think in milliseconds): it is made again.
    const slower = produce(project, (draft) => void (draft.transport.bpm = 100));
    expect(events(slower, patternId)[0]).not.toBe(first[0]);
    const edited = produce(project, (draft) => {
      setMidiFxParam(draft, channelId, firstSlot(draft, channelId), 'rate', '1/8');
    });
    expect(events(edited, patternId)).toHaveLength(8);
  });
});

describe('the transport sending notes the effects made', () => {
  function transportFor(project: Project, patternId: PatternId) {
    const clock = { currentTime: 0 };
    const calls: { t: 'on' | 'off'; time: number; noteId: number; key: number }[] = [];
    const sink: TransportSink = {
      noteOn: (_c, e) => calls.push({ t: 'on', time: e.time, noteId: e.noteId, key: e.key }),
      noteOff: (_c, e) => calls.push({ t: 'off', time: e.time, noteId: e.noteId, key: e.key }),
      allNotesOff: () => {},
    };
    const tempo = constantTempo(120);
    const model = (p: Project) => {
      const { source, length } = patternModeSource(p, patternId);
      return { source, timeline: { tempo, loop: { start: 0, end: length }, endTick: length } };
    };
    const m = model(project);
    const transport = new Transport(clock, sink, m.source, m.timeline);
    const run = (until: number) => {
      while (clock.currentTime < until) {
        clock.currentTime += 0.025;
        transport.pump();
      }
    };
    return { transport, clock, calls, run, model };
  }

  it('sends the arpeggio at exact times: a 1/16 at 120 BPM is 0.125 s', () => {
    const { project, patternId } = rig();
    const t = transportFor(project, patternId);
    t.transport.start(0, 0.1);
    t.run(1);
    const ons = t.calls.filter((c) => c.t === 'on').map((c) => c.time);
    expect(ons.slice(0, 6).map((x) => +x.toFixed(9))).toEqual([0.1, 0.225, 0.35, 0.475, 0.6, 0.725]);
    expect(t.calls.filter((c) => c.t === 'on').slice(0, 4).map((c) => c.key)).toEqual([60, 64, 67, 60]);
  });

  it('an edit that does not touch the channel leaves the arpeggio exactly where it was', () => {
    const { project, patternId } = rig();
    const steady = transportFor(project, patternId);
    steady.transport.start(0, 0.1);
    steady.run(3.5);
    const edited = transportFor(project, patternId);
    edited.transport.start(0, 0.1);
    edited.run(0.9);
    // A tempo-neutral edit of something else: another channel gets a note while playing.
    const other = makeInstrumentChannel('Bass', makePluginInstance('x', 1, {}));
    const changed = produce(project, (draft) => {
      addChannel(draft, other);
      addNote(draft, patternId, other.id, { id: 'n_bass' as NoteId, tick: 0, length: STEP, key: 36, velocity: 1 });
    });
    const m = edited.model(changed);
    edited.transport.setModel(m.source, m.timeline);
    edited.run(3.5);
    // A re-plan cancels what was sent ahead of it and sends it again: only notes that were not cancelled count.
    const arp = (calls: typeof steady.calls) =>
      calls
        .filter((c) => c.t === 'on' && c.key !== 36)
        .filter((on) => !calls.some((c) => c.t === 'off' && c.noteId === on.noteId && c.time <= on.time))
        .map((c) => [+c.time.toFixed(9), c.key]);
    expect(arp(edited.calls)).toEqual(arp(steady.calls));
  });

  it('an edit to the arpeggiator re-plans from the next step, on the grid, and cuts nothing that is sounding', () => {
    const { project, patternId, channelId } = rig();
    const t = transportFor(project, patternId);
    t.transport.start(0, 0);
    t.run(0.5);
    const faster = produce(project, (draft) => {
      setMidiFxParam(draft, channelId, firstSlot(draft, channelId), 'rate', '1/32');
    });
    const m = t.model(faster);
    t.transport.setModel(m.source, m.timeline);
    t.run(1.6);
    const ons = t.calls.filter((c) => c.t === 'on');
    const after = ons.filter((c) => c.time > 0.52).map((c) => c.time);
    // From the re-plan on, notes are on the 1/32 grid (62.5 ms), still counted from the start of the bar.
    for (const time of after.slice(0, 6)) expect((time / 0.0625) % 1).toBeCloseTo(0, 6);
    // Every note that sounded got exactly one release, after its start (nothing was cut at the re-plan, nothing is stuck).
    for (const on of ons.filter((c) => c.time < 1.4)) {
      const offs = t.calls.filter((c) => c.t === 'off' && c.noteId === on.noteId);
      expect(offs.length, `note at ${on.time}`).toBeLessThanOrEqual(1);
    }
  });

  it('a re-plan that changes nothing for the channel releases every sounding note at its own end', () => {
    const { project, patternId } = rig();
    const t = transportFor(project, patternId);
    t.transport.start(0, 0);
    t.run(0.6);
    const renamed = produce(project, (draft) => void (draft.meta.title = 'Another title'));
    const m = t.model(renamed);
    t.transport.setModel(m.source, m.timeline);
    t.run(2.1);
    const ons = t.calls.filter((c) => c.t === 'on' && c.time < 1.9);
    expect(ons.length).toBeGreaterThan(10);
    for (const on of ons) {
      const offs = t.calls.filter((c) => c.t === 'off' && c.noteId === on.noteId);
      // A note the re-plan cancelled before it began was sent again; every other one ends at its own end (80 % of a 0.125 s step).
      if (offs.some((c) => c.time <= on.time)) continue;
      expect(offs.map((c) => +(c.time - on.time).toFixed(9))).toEqual([0.1]);
    }
    expect(ons.filter((on) => on.time < 0.55 && !t.calls.some((c) => c.t === 'off' && c.noteId === on.noteId && c.time <= on.time))).toHaveLength(5);
  });
});
