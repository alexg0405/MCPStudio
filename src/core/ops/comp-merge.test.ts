/**
 * A comp that plays takes of two recordings of the same part ("Add these takes to the comp"), and a take clip's own gain
 * or fade reaching the comp clips that play it.
 */
import { describe, expect, it } from 'vitest';
import { fillGaps } from '../audio/comp';
import { History } from '../history/history';
import { createEmptyProject } from '../model/defaults';
import type { AudioClip, AudioClipChannel, ChannelId, Project, SampleId } from '../model/types';
import { buildTakeGroups, overlappingGroups, takeGroups } from '../query/takes';
import { migrateProject, repairProject } from '../schema/migrate';
import { constantTempo } from '../time/ppq';
import { setAudioClipEdits } from './audio-edits';
import { addChannel, addSample } from './channels';
import { addClips } from './playlist';
import { addTakeGroup, addTakesToComp, compSegmentsOf, compSwipe, compUseTake, newTakeGroup } from './comp';

const tempo = constantTempo(120); // 1920 ticks per second
const LOOP = 7680; // 4 s

function channelFor(n: number): AudioClipChannel {
  return {
    kind: 'audioClip',
    id: `ch_rec${n}` as ChannelId,
    name: `Recording ${n}`,
    color: '#fff',
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    output: 'master' as never,
    sampleId: `smp_rec${n}` as SampleId,
  };
}

/** Two recordings of the same four seconds: A has three takes, B has two (and starts a little later). */
function setup(secondStart = 0) {
  let doc: Project = createEmptyProject();
  const history = new History({ get: () => doc, set: (p) => void (doc = p) });
  const groupA = newTakeGroup();
  const groupB = newTakeGroup();
  history.transact('Record A', (d) => {
    addSample(d, { id: 'smp_rec1' as SampleId, name: 'a', source: { kind: 'builtin', generator: 'x', version: 1 } });
    addChannel(d, channelFor(1));
    addTakeGroup(d, {
      group: groupA,
      name: 'Recording 1',
      channelId: 'ch_rec1' as ChannelId,
      takes: [0, 1, 2].map((i) => ({ start: 0, length: LOOP, offsetSec: i * 4 })),
      audible: 2,
      first: 0,
      tempo,
    });
  });
  history.transact('Record B', (d) => {
    addSample(d, { id: 'smp_rec2' as SampleId, name: 'b', source: { kind: 'builtin', generator: 'x', version: 1 } });
    addChannel(d, channelFor(2));
    addTakeGroup(d, {
      group: groupB,
      name: 'Recording 2',
      channelId: 'ch_rec2' as ChannelId,
      takes: [0, 1].map((i) => ({ start: secondStart, length: LOOP - secondStart, offsetSec: 10 + i * 5 })),
      audible: 1,
      first: 4,
      tempo,
    });
  });
  return { history, get: () => doc, groupA, groupB };
}

const grp = (p: Project, id: string) => takeGroups(p).find((g) => g.id === id)!;

describe('add these takes to the comp', () => {
  it('the other recording’s takes join the group with new take numbers; its comp track goes', () => {
    const { history, get, groupA, groupB } = setup();
    const before = get();
    expect(history.transact('Add takes', (d) => void expect(addTakesToComp(d, groupB, groupA, tempo)).toMatchObject({ takes: 2 }))).toBe(true);
    const p = get();
    expect(takeGroups(p).map((g) => g.id)).toEqual([groupA]);
    const g = grp(p, groupA);
    expect(g.takes.map((t) => t.index)).toEqual([0, 1, 2, 3, 4]);
    // The new takes keep their own recording (channel, trim) and their own tracks, now under this comp track.
    expect(g.takes.slice(3).map((t) => t.clips[0]!.channelId)).toEqual(['ch_rec2', 'ch_rec2']);
    expect(g.takes.slice(3).map((t) => t.clips[0]!.offsetSec)).toEqual([10, 15]);
    expect(g.takeLanes).toHaveLength(5);
    const order = p.playlist.laneOrder;
    const at = order.indexOf(g.compLane!);
    expect(order.slice(at + 1, at + 6).every((id) => p.playlist.lanes[id]!.takes?.role === 'take')).toBe(true);
    // The other comp track is gone (one lane fewer than before, takes tracks aside).
    expect(order).toHaveLength(before.playlist.laneOrder.length - 1);
    expect(history.undo()).toBe(true);
    expect(get()).toEqual(before);
  });

  it('what this comp plays does not change; the other comp’s parts fill only the gaps', () => {
    const { history, get, groupA, groupB } = setup(960);
    // A's comp plays take 1 for the first second only (a gap after it): clear the rest by cutting it.
    history.transact('Use take', (d) => void compUseTake(d, groupA, 2, tempo));
    history.transact('Trim', (d) => {
      for (const c of buildTakeGroups(d.playlist).find((x) => x.id === groupA)!.comp) d.playlist.clips[c.id]!.length = 1920;
    });
    const own = compSegmentsOf(grp(get(), groupA));
    expect(own).toEqual([{ take: 2, from: 0, to: 1920 }]);
    // B's comp plays its second take over its whole length (960 – 7680).
    history.transact('Add takes', (d) => void addTakesToComp(d, groupB, groupA, tempo));
    expect(compSegmentsOf(grp(get(), groupA))).toEqual([
      { take: 2, from: 0, to: 1920 },
      { take: 4, from: 1920, to: LOOP },
    ]);
  });

  it('the comp can play a segment from either recording: each comp clip plays its own sample at the right place', () => {
    const { history, get, groupA, groupB } = setup();
    history.transact('Add takes', (d) => void addTakesToComp(d, groupB, groupA, tempo));
    // Take 4 (index 3) is B's first take: it plays bar 1 beat 2 to 3 (1920–3840).
    history.transact('Swipe', (d) => void compSwipe(d, groupA, 3, 1920, 3840, tempo));
    const g = grp(get(), groupA);
    expect(g.comp.map((c) => [c.take?.index, c.channelId])).toEqual([
      [2, 'ch_rec1'],
      [3, 'ch_rec2'],
      [2, 'ch_rec1'],
    ]);
    const [, b] = g.comp as [AudioClip, AudioClip, AudioClip];
    // B's first take starts 10 s into its sample and plays from tick 0, so tick 1910 is 10 + 1910/1920 s in.
    expect(b.offsetSec).toBeCloseTo(10 + b.start / 1920, 6);
    // And the other way round: a part of A's own take in a comp that also has B's takes.
    history.transact('Swipe', (d) => void compSwipe(d, groupA, 0, 5760, 6720, tempo));
    const after = grp(get(), groupA).comp;
    expect(after.map((c) => c.channelId)).toEqual(['ch_rec1', 'ch_rec2', 'ch_rec1', 'ch_rec1', 'ch_rec1']);
  });

  it('a swipe, then undo, then redo, returns exactly', () => {
    const { history, get, groupA, groupB } = setup();
    history.transact('Add takes', (d) => void addTakesToComp(d, groupB, groupA, tempo));
    const added = get();
    history.transact('Swipe', (d) => void compSwipe(d, groupA, 4, 1000, 5000, tempo));
    const swiped = get();
    expect(history.undo()).toBe(true);
    expect(get()).toEqual(added);
    expect(history.redo()).toBe(true);
    expect(get()).toEqual(swiped);
  });

  it('hand-made gains on this comp survive', () => {
    const { history, get, groupA, groupB } = setup();
    history.transact('Hand edit', (d) => {
      const [c] = buildTakeGroups(d.playlist).find((x) => x.id === groupA)!.comp;
      Object.assign(d.playlist.clips[c!.id]!, { gain: 0.5 });
    });
    history.transact('Add takes', (d) => void addTakesToComp(d, groupB, groupA, tempo));
    expect(grp(get(), groupA).comp.map((c) => c.gain)).toEqual([0.5]);
  });

  it('refuses recordings that do not overlap, the same group, or one without takes', () => {
    const { history, get, groupA, groupB } = setup(LOOP - 100);
    const before = get();
    // B is only 100 ticks long and sits at the end: it does overlap (by 100 ticks).
    expect(overlappingGroups(get(), grp(get(), groupA)).map((g) => g.id)).toEqual([groupB]);
    // Move B's takes past A's end: no overlap any more.
    history.transact('Move', (d) => {
      for (const c of grp(get(), groupB).takes.flatMap((t) => t.clips)) d.playlist.clips[c.id]!.start = LOOP + 960;
    });
    const moved = get();
    expect(overlappingGroups(moved, grp(moved, groupA))).toEqual([]);
    const results: unknown[] = [];
    history.transact('Try', (d) => {
      results.push(addTakesToComp(d, groupB, groupA, tempo), addTakesToComp(d, groupA, groupA, tempo), addTakesToComp(d, 'nope', groupA, tempo));
    });
    expect(results).toEqual([null, null, null]);
    expect(get()).toBe(moved);
    expect(before).not.toBe(moved);
  });

  it('overlappingGroups lists the best overlap first and leaves out the group itself', () => {
    const { get, groupA, groupB } = setup(960);
    expect(overlappingGroups(get(), grp(get(), groupA)).map((g) => g.id)).toEqual([groupB]);
    expect(overlappingGroups(get(), grp(get(), groupB)).map((g) => g.id)).toEqual([groupA]);
  });

  it('a merged group survives a save and load without repairs, and its takes keep their recordings', () => {
    const { history, get, groupA, groupB } = setup();
    history.transact('Add takes', (d) => void addTakesToComp(d, groupB, groupA, tempo));
    history.transact('Swipe', (d) => void compSwipe(d, groupA, 3, 1920, 3840, tempo));
    const raw = JSON.parse(JSON.stringify(get()));
    const { project, repairs } = repairProject(migrateProject(raw).project);
    expect(repairs).toEqual([]);
    const g = buildTakeGroups(project.playlist).find((x) => x.id === groupA)!;
    expect(g.takes.map((t) => t.index)).toEqual([0, 1, 2, 3, 4]);
    expect(g.comp.map((c) => c.channelId)).toEqual(['ch_rec1', 'ch_rec2', 'ch_rec1']);
  });

  it('an old project (two separate recordings, no merge) is untouched by repair', () => {
    const { get } = setup();
    const { project, repairs } = repairProject(migrateProject(JSON.parse(JSON.stringify(get()))).project);
    expect(repairs).toEqual([]);
    expect(buildTakeGroups(project.playlist)).toHaveLength(2);
  });
});

describe('fillGaps', () => {
  it('adds only the parts of the extra segments where the base plays nothing', () => {
    const base = [
      { take: 0, from: 100, to: 200 },
      { take: 1, from: 300, to: 400 },
    ];
    const extra = [{ take: 5, from: 0, to: 500 }];
    expect(fillGaps(base, extra)).toEqual([
      { take: 5, from: 0, to: 100 },
      { take: 0, from: 100, to: 200 },
      { take: 5, from: 200, to: 300 },
      { take: 1, from: 300, to: 400 },
      { take: 5, from: 400, to: 500 },
    ]);
    expect(fillGaps(base, [])).toEqual(base);
    expect(fillGaps([], extra)).toEqual(extra);
  });
});

describe('a take clip’s own gain and fades reach the comp clips that play it', () => {
  /** Edits a take clip's level the way the playlist does: through setAudioClipEdits with the tempo. */
  const restyle = (history: History, id: string, edits: Parameters<typeof setAudioClipEdits>[2]) =>
    history.transact('Take level', (d) => setAudioClipEdits(d, id as never, edits, { tempo }));
  const takeClip = (p: Project, group: string, index: number) => grp(p, group).takes.find((t) => t.index === index)!.clips[0]!;

  it('a take’s gain change reaches the comp clips that play it, and undo takes it back exactly', () => {
    const { history, get, groupA } = setup();
    history.transact('Swipe', (d) => void compSwipe(d, groupA, 0, 1920, 3840, tempo));
    const before = get();
    // The comp plays take 2 (index 2) around the swiped part; take 0 plays 1920–3840.
    restyle(history, takeClip(before, groupA, 2).id, { gain: 0.5 });
    const g = grp(get(), groupA);
    expect(g.comp.map((c) => [c.take?.index, c.gain])).toEqual([
      [2, 0.5],
      [0, undefined],
      [2, 0.5],
    ]);
    expect(history.undo()).toBe(true);
    expect(get()).toEqual(before);
  });

  it('a comp clip with a gain of its own keeps it; the other clips of that take follow', () => {
    const { history, get, groupA } = setup();
    history.transact('Swipe', (d) => void compSwipe(d, groupA, 0, 1920, 3840, tempo));
    history.transact('Hand edit', (d) => {
      const [first] = buildTakeGroups(d.playlist).find((x) => x.id === groupA)!.comp;
      Object.assign(d.playlist.clips[first!.id]!, { gain: 2 });
    });
    restyle(history, takeClip(get(), groupA, 2).id, { gain: 0.5 });
    expect(grp(get(), groupA).comp.map((c) => c.gain)).toEqual([2, undefined, 0.5]);
  });

  it('a take’s fade reaches the comp’s outer edge only; the crossfades stay', () => {
    const { history, get, groupA } = setup();
    history.transact('Swipe', (d) => void compSwipe(d, groupA, 0, 1920, 3840, tempo));
    const crossfade = grp(get(), groupA).comp[0]!.fadeOut;
    restyle(history, takeClip(get(), groupA, 2).id, { fadeIn: 0.2, fadeOut: 0.3 });
    const g = grp(get(), groupA);
    expect(g.comp[0]!.fadeIn).toBeCloseTo(0.2, 6);
    expect(g.comp[0]!.fadeOut).toBeCloseTo(crossfade!, 6);
    expect(g.comp[2]!.fadeOut).toBeCloseTo(0.3, 6);
  });

  it('a take the comp does not play changes nothing in the comp (same clips, same ids)', () => {
    const { history, get, groupA } = setup();
    const before = grp(get(), groupA).comp.map((c) => c.id);
    restyle(history, takeClip(get(), groupA, 0).id, { gain: 0.25, fadeIn: 0.1 });
    expect(grp(get(), groupA).comp.map((c) => c.id)).toEqual(before);
    expect(takeClip(get(), groupA, 0).gain).toBe(0.25);
  });

  it('works for a take that came from the other recording', () => {
    const { history, get, groupA, groupB } = setup();
    history.transact('Add takes', (d) => void addTakesToComp(d, groupB, groupA, tempo));
    history.transact('Swipe', (d) => void compSwipe(d, groupA, 3, 1920, 3840, tempo));
    restyle(history, takeClip(get(), groupA, 3).id, { gain: 1.5 });
    expect(grp(get(), groupA).comp.map((c) => [c.channelId, c.gain])).toEqual([
      ['ch_rec1', undefined],
      ['ch_rec2', 1.5],
      ['ch_rec1', undefined],
    ]);
  });

  it('a clip that is not a take clip is edited as before (no comp is touched)', () => {
    const { history, get, groupA } = setup();
    history.transact('Add clip', (d) =>
      addClips(d, [{ kind: 'audio', id: 'clip_plain' as never, laneId: d.playlist.laneOrder[9]!, start: 0, length: 960, channelId: 'ch_rec1' as ChannelId, offsetSec: 0 }]),
    );
    const comp = grp(get(), groupA).comp.map((c) => c.id);
    restyle(history, 'clip_plain', { gain: 0.5 });
    expect((get().playlist.clips['clip_plain' as never] as AudioClip).gain).toBe(0.5);
    expect(grp(get(), groupA).comp.map((c) => c.id)).toEqual(comp);
  });
});
