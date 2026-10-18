/**
 * Comps keep a hand-made gain or fade across rebuilds, follow a take clip that is moved or resized (one undo step),
 * and recordings' own tracks hold only that recording.
 */
import { describe, expect, it } from 'vitest';
import { laneNamed } from '../arrange/apply';
import { History } from '../history/history';
import { createEmptyProject, makeLane } from '../model/defaults';
import type { AudioClip, AudioClipChannel, ClipId, Project, SampleId } from '../model/types';
import { takeGroups } from '../query/takes';
import { constantTempo } from '../time/ppq';
import { addChannel, addSample } from './channels';
import { compSegmentsOf, compSetCrossfade, compSwipe, addTakeGroup, newTakeGroup, compUseTake } from './comp';
import { createAutomationClip, firstFreeLane } from './automation';
import { addClips, addLane, editClips, ordinaryLaneFor } from './playlist';

const tempo = constantTempo(120); // 1920 ticks per second

function setup() {
  let doc: Project = createEmptyProject();
  const history = new History({ get: () => doc, set: (p) => void (doc = p) });
  const channel: AudioClipChannel = {
    kind: 'audioClip',
    id: 'ch_rec' as AudioClipChannel['id'],
    name: 'Recording 1',
    color: '#fff',
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    output: 'master' as never,
    sampleId: 'smp_rec' as SampleId,
  };
  const group = newTakeGroup();
  history.transact('Record 3 takes', (d) => {
    addSample(d, { id: 'smp_rec' as SampleId, name: 'rec', source: { kind: 'builtin', generator: 'x', version: 1 } });
    addChannel(d, channel);
    addTakeGroup(d, {
      group,
      name: 'Recording 1',
      channelId: channel.id,
      takes: [0, 1, 2].map((i) => ({ start: 0, length: 7680, offsetSec: i * 4 })),
      audible: 2,
      first: 0,
      tempo,
    });
  });
  return { history, get: () => doc, group };
}

const grp = (p: Project, group: string) => takeGroups(p).find((g) => g.id === group)!;
const setEdit = (history: History, id: ClipId, patch: Partial<AudioClip>) =>
  history.transact('Hand edit', (d) => void Object.assign(d.playlist.clips[id]!, patch));

describe('hand-made gains and fades survive a comp rebuild', () => {
  it('a gain and an outer fade stay when another part of the comp is swiped', () => {
    const { history, get, group } = setup();
    history.transact('Swipe', (d) => void compSwipe(d, group, 0, 1920, 3840, tempo));
    const [a] = grp(get(), group).comp;
    expect(a!.take?.index).toBe(2);
    setEdit(history, a!.id, { gain: 0.5, fadeIn: 0.05 });
    // Another swipe far from it rebuilds the whole lane.
    history.transact('Swipe 2', (d) => void compSwipe(d, group, 1, 5760, 6720, tempo));
    const g = grp(get(), group);
    expect(g.comp.map((c) => c.take?.index)).toEqual([2, 0, 2, 1, 2]);
    const first = g.comp[0]!;
    expect(first.gain).toBe(0.5);
    expect(first.fadeIn).toBeCloseTo(0.05, 6);
    // Only that clip: the rest keep the plan's values.
    expect(g.comp.slice(1).every((c) => c.gain === undefined)).toBe(true);
    // The crossfade at its right border is still the plan's.
    expect(first.fadeOut).toBeCloseTo(0.0104, 3);
  });

  it('a gain stays on the part of a clip that is left when a swipe cuts it', () => {
    const { history, get, group } = setup();
    setEdit(history, grp(get(), group).comp[0]!.id, { gain: 0.25 });
    history.transact('Swipe', (d) => void compSwipe(d, group, 1, 3000, 4000, tempo));
    const g = grp(get(), group);
    expect(g.comp.map((c) => [c.take?.index, c.gain])).toEqual([
      [2, 0.25],
      [1, undefined],
      [2, 0.25],
    ]);
  });

  it('changing the crossfade still changes the borders (an edit is measured before it)', () => {
    const { history, get, group } = setup();
    history.transact('Swipe', (d) => void compSwipe(d, group, 0, 1920, 3840, tempo));
    setEdit(history, grp(get(), group).comp[0]!.id, { gain: 0.5 });
    history.transact('Crossfade', (d) => compSetCrossfade(d, group, 40, tempo));
    const g = grp(get(), group);
    expect(g.comp[0]!.gain).toBe(0.5);
    expect(g.comp[0]!.fadeOut).toBeCloseTo(0.04, 2);
    expect(g.comp[1]!.fadeIn).toBeCloseTo(0.04, 2);
    expect(g.comp[1]!.gain).toBeUndefined();
  });

  it('use this take replaces the comp: an edit on a part of another take does not follow', () => {
    const { history, get, group } = setup();
    setEdit(history, grp(get(), group).comp[0]!.id, { gain: 0.5 });
    history.transact('Use take 1', (d) => void compUseTake(d, group, 0, tempo));
    expect(grp(get(), group).comp.map((c) => c.gain)).toEqual([undefined]);
  });
});

describe('moving or resizing a take clip', () => {
  // Take 1 plays the last two beats of the comp (ticks 5760-7680); take 3 plays the rest.
  const swiped = () => {
    const s = setup();
    s.history.transact('Swipe', (d) => void compSwipe(d, s.group, 0, 5760, 7680, tempo));
    return s;
  };
  const takeClip = (p: Project, group: string, index: number) => grp(p, group).takes.find((t) => t.index === index)!.clips[0]!;
  const partOf = (p: Project, group: string) => grp(p, group).comp.find((c) => c.take?.index === 0)!;

  it('what the comp plays of a moved take goes with it, in the same undo step', () => {
    const { history, get, group } = swiped();
    const before = get();
    const t0 = takeClip(before, group, 0);
    history.transact('Move clip', (d) => editClips(d, [{ id: t0.id, start: t0.start + 960 }], { tempo }));
    expect(compSegmentsOf(grp(get(), group))).toEqual([
      { take: 2, from: 0, to: 5760 },
      { take: 0, from: 6720, to: 8640 },
    ]);
    // It plays the same audio of the take as before, 960 ticks later.
    const part = partOf(get(), group);
    const was = partOf(before, group);
    // (the crossfade into the take is gone: the take no longer touches the one before it)
    expect(part.start).toBe(6720);
    expect(was.start).toBe(5750);
    expect(part.offsetSec).toBeCloseTo((part.start - 960) / 1920, 6);
    expect(was.offsetSec).toBeCloseTo(was.start / 1920, 6);
    expect(part.start + part.length).toBe(was.start + was.length + 960);
    // One undo step undoes the move and the comp together.
    expect(history.undo()).toBe(true);
    expect(get()).toEqual(before);
    expect(history.redo()).toBe(true);
    expect(partOf(get(), group).start).toBe(6720);
  });

  it('trimming the take from the right cuts the comp to what is left; from the left keeps the audio in place', () => {
    const { history, get, group } = swiped();
    const before = get();
    const t0 = takeClip(before, group, 0);
    history.transact('Resize', (d) => editClips(d, [{ id: t0.id, length: 6720 }], { tempo }));
    expect(compSegmentsOf(grp(get(), group)).find((s) => s.take === 0)).toEqual({ take: 0, from: 5760, to: 6720 });
    expect(history.undo()).toBe(true);
    expect(get()).toEqual(before);
    // Left trim: the start moves later and the trim follows, so the audio stays where it was.
    history.transact('Resize left', (d) =>
      editClips(d, [{ id: t0.id, start: 6720, length: t0.length - 6720, offsetSec: t0.offsetSec + 6720 / 1920 }], { tempo }),
    );
    expect(compSegmentsOf(grp(get(), group)).find((s) => s.take === 0)).toEqual({ take: 0, from: 6720, to: 7680 });
    const part = partOf(get(), group);
    // The sample position under the comp is what the take clip itself plays there.
    expect(part.offsetSec).toBeCloseTo(t0.offsetSec + part.start / 1920, 6);
  });

  it('a hand-made gain on the comp survives the take being moved', () => {
    const { history, get, group } = swiped();
    setEdit(history, partOf(get(), group).id, { gain: 0.4 });
    const t0 = takeClip(get(), group, 0);
    history.transact('Move clip', (d) => editClips(d, [{ id: t0.id, start: t0.start + 960 }], { tempo }));
    expect(partOf(get(), group).gain).toBe(0.4);
  });

  it('an edit that does not change the takes leaves the comp alone; without a tempo nothing is rebuilt', () => {
    const { history, get, group } = swiped();
    const before = grp(get(), group).comp.map((c) => c.id);
    const t0 = takeClip(get(), group, 0);
    history.transact('Mute', (d) => editClips(d, [{ id: t0.id, muted: true }], { tempo }));
    expect(grp(get(), group).comp.map((c) => c.id)).toEqual(before);
    history.transact('Move', (d) => editClips(d, [{ id: t0.id, start: 960 }]));
    expect(grp(get(), group).comp.map((c) => c.id)).toEqual(before);
  });

  it('a take clip stays on its track', () => {
    const { history, get, group } = swiped();
    const t0 = takeClip(get(), group, 0);
    const other = get().playlist.laneOrder[8]!;
    history.transact('Move', (d) => editClips(d, [{ id: t0.id, laneId: other, start: 100 }], { tempo }));
    expect(get().playlist.clips[t0.id]!.laneId).toBe(t0.laneId);
    expect(get().playlist.clips[t0.id]!.start).toBe(100);
  });
});

describe('a recording keeps its own tracks', () => {
  const clip = (laneId: string, start = 0, length = 1920): AudioClip => ({
    kind: 'audio',
    id: `clip_${Math.random().toString(36).slice(2)}` as ClipId,
    laneId: laneId as never,
    start,
    length,
    channelId: 'ch_rec' as never,
    offsetSec: 0,
  });

  it('a clip added to a comp or take track lands on the first ordinary track with room', () => {
    const { history, get, group } = setup();
    const g = grp(get(), group);
    const c = clip(g.compLane!);
    history.transact('Drop', (d) => addClips(d, [c]));
    const placed = get().playlist.clips[c.id]!;
    expect(get().playlist.lanes[placed.laneId]!.takes).toBeUndefined();
    // Tracks 1-4 are the recording's; the next one is free.
    expect(get().playlist.laneOrder.indexOf(placed.laneId)).toBe(4);
    // Two overlapping drops go to two tracks.
    const c2 = clip(g.takeLanes[0]!);
    history.transact('Drop 2', (d) => addClips(d, [c2]));
    expect(get().playlist.laneOrder.indexOf(get().playlist.clips[c2.id]!.laneId)).toBe(5);
  });

  it('a new track is added when every ordinary track is taken', () => {
    const { history, get, group } = setup();
    history.transact('Fill', (d) => {
      for (const id of d.playlist.laneOrder) if (!d.playlist.lanes[id]!.takes) addClips(d, [clip(id)]);
    });
    const lanes = get().playlist.laneOrder.length;
    const c = clip(grp(get(), group).compLane!);
    history.transact('Drop', (d) => addClips(d, [c]));
    expect(get().playlist.laneOrder.length).toBe(lanes + 1);
    expect(get().playlist.lanes[get().playlist.clips[c.id]!.laneId]!.takes).toBeUndefined();
  });

  it('addClips with toTakeLanes (the recorder itself) keeps the lane', () => {
    const { history, get, group } = setup();
    const lane = grp(get(), group).compLane!;
    const c = clip(lane);
    history.transact('Own', (d) => addClips(d, [c], { toTakeLanes: true }));
    expect(get().playlist.clips[c.id]!.laneId).toBe(lane);
  });

  it('another clip cannot be moved onto one', () => {
    const { history, get, group } = setup();
    const free = get().playlist.laneOrder[6]!;
    const c = clip(free);
    history.transact('Add', (d) => addClips(d, [c]));
    const comp = grp(get(), group).compLane!;
    history.transact('Move', (d) => editClips(d, [{ id: c.id, laneId: comp }]));
    expect(get().playlist.clips[c.id]!.laneId).toBe(free);
  });

  it('an automation clip asked for on one of those tracks goes to a free ordinary track', () => {
    const { history, get, group } = setup();
    const comp = grp(get(), group).compLane!;
    let laneId: string | undefined;
    history.transact('Automate', (d) => {
      laneId = createAutomationClip(d, { target: { kind: 'tempo' }, name: 'Tempo', color: '#fff', start: 0, length: 3840, laneId: comp }).laneId;
    });
    expect(laneId).toBeDefined();
    expect(get().playlist.lanes[laneId as never]!.takes).toBeUndefined();
    expect(laneId).not.toBe(comp);
  });

  it('automation, the arranger and ordinaryLaneFor never choose them', () => {
    const { history, get, group } = setup();
    const taken = new Set([grp(get(), group).compLane, ...grp(get(), group).takeLanes]);
    expect(taken.has(firstFreeLane(get(), 0, 1920))).toBe(false);
    expect(firstFreeLane(get(), 0, 1920)).toBe(get().playlist.laneOrder[4]);
    history.transact('Names', (d) => {
      // A track named like a comp track is not picked, and a take track is not renamed as the first free "Track N".
      const compName = d.playlist.lanes[grp(get(), group).compLane!]!.name;
      const id = laneNamed(d, compName);
      expect(d.playlist.lanes[id]!.takes).toBeUndefined();
      const id2 = laneNamed(d, 'Drums');
      expect(d.playlist.lanes[id2]!.takes).toBeUndefined();
      const lane = makeLane('Spare');
      addLane(d, lane);
      expect(ordinaryLaneFor(d, 0, 10)).not.toBe(grp(get(), group).compLane);
    });
  });
});
