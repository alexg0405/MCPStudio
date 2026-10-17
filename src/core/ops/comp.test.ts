import { describe, expect, it } from 'vitest';
import { History } from '../history/history';
import { createEmptyProject } from '../model/defaults';
import type { AudioClip, AudioClipChannel, Project, SampleId } from '../model/types';
import { constantTempo } from '../time/ppq';
import { buildTakeGroups, takeGroups, visibleLaneOrder } from '../query/takes';
import { compSegmentsOf, compStep, compSwipe, compUseTake, compSetCrossfade, addTakeGroup, flattenComp, newTakeGroup } from './comp';
import { addChannel, addSample } from './channels';
import { migrateProject, repairProject } from '../schema/migrate';


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
      // Three passes of the same 4-beat loop (7680 ticks = 4 s), their audio 4 s apart in the recording.
      takes: [0, 1, 2].map((i) => ({ start: 0, length: 7680, offsetSec: i * 4 })),
      audible: 2,
      first: 0,
      tempo,
    });
  });
  return { history, get: () => doc, group };
}

const comp = (p: Project, group: string) => takeGroups(p).find((g) => g.id === group)!;

describe('take groups', () => {
  it('a recording of three takes: a comp lane on top, the take lanes under it, newest take on the comp first', () => {
    const { get, group } = setup();
    const p = get();
    const g = comp(p, group);
    expect(g.takes.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(p.playlist.laneOrder.slice(0, 4).map((id) => p.playlist.lanes[id]!.takes?.role)).toEqual(['comp', 'take', 'take', 'take']);
    // Newest take nearest the comp.
    expect(g.takeLanes.map((id) => p.playlist.lanes[id]!.name)).toEqual([
      'Recording 1 · take 3',
      'Recording 1 · take 2',
      'Recording 1 · take 1',
    ]);
    expect(g.takes.every((t) => t.clips.every((c) => c.muted))).toBe(true);
    expect(g.comp).toHaveLength(1);
    expect(g.comp[0]).toMatchObject({ start: 0, length: 7680, take: { index: 2, comp: true } });
    // The comp plays take 3's audio: 8 s into the recording.
    expect(g.comp[0]!.offsetSec).toBeCloseTo(8, 9);
  });

  it('folded take lanes are left out of the visible tracks', () => {
    const { get, group } = setup();
    const p = get();
    const all = p.playlist.laneOrder;
    const folded = visibleLaneOrder(p, []);
    expect(folded.length).toBe(all.length - 3);
    expect(folded[0]).toBe(comp(p, group).compLane);
    expect(visibleLaneOrder(p, [group])).toEqual(all);
    // Memoized per state.
    expect(visibleLaneOrder(p, [])).toBe(folded);
  });
});

describe('comp edits', () => {
  it('a swipe splits the comp lane at the borders with crossfades; undo restores it exactly', () => {
    const { history, get, group } = setup();
    const before = get();
    history.transact('Comp', (d) => void compSwipe(d, group, 0, 1920, 3840, tempo));
    const g = comp(get(), group);
    expect(g.comp.map((c) => c.take?.index)).toEqual([2, 0, 2]);
    expect(compSegmentsOf(g)).toEqual([
      { take: 2, from: 0, to: 1920 },
      { take: 0, from: 1920, to: 3840 },
      { take: 2, from: 3840, to: 7680 },
    ]);
    // Crossfades: the clips overlap by about 10 ms, fades equal the overlap, and each plays its own audio.
    const [a, b, c] = g.comp as [AudioClip, AudioClip, AudioClip];
    expect(a.start + a.length).toBeGreaterThan(b.start);
    expect(a.fadeOut).toBeCloseTo(0.0104, 3);
    expect(b.fadeIn).toBeCloseTo(0.0104, 3);
    // Take 1 (index 0) at tick 1910 is 1910/1920 s into its pass, which starts at 0 s in the sample.
    expect(b.offsetSec).toBeCloseTo((b.start / 1920), 6);
    // Take 3 (index 2) is 8 s in.
    expect(c.offsetSec).toBeCloseTo(8 + c.start / 1920, 6);
    expect(history.undo()).toBe(true);
    expect(get()).toEqual(before);
    expect(history.redo()).toBe(true);
    expect(compSegmentsOf(comp(get(), group))).toHaveLength(3);
  });

  it('use this take, next and previous take, crossfade length: one undo step each', () => {
    const { history, get, group } = setup();
    const states = [get()];
    const step = (label: string, f: Parameters<typeof history.transact>[1]) => {
      expect(history.transact(label, f)).toBe(true);
      states.push(get());
    };
    step('Use take 1', (d) => void compUseTake(d, group, 0, tempo));
    expect(compSegmentsOf(comp(get(), group))).toEqual([{ take: 0, from: 0, to: 7680 }]);
    step('Next take', (d) => void expect(compStep(d, group, 3840, 5760, 1, tempo)).toBe(1));
    expect(compSegmentsOf(comp(get(), group))).toEqual([
      { take: 0, from: 0, to: 3840 },
      { take: 1, from: 3840, to: 5760 },
      { take: 0, from: 5760, to: 7680 },
    ]);
    step('Previous take', (d) => void expect(compStep(d, group, 3840, 5760, -1, tempo)).toBe(0));
    expect(compSegmentsOf(comp(get(), group))).toEqual([{ take: 0, from: 0, to: 7680 }]);
    step('Crossfade', (d) => void compSwipe(d, group, 2, 1000, 2000, tempo));
    step('Crossfade 40 ms', (d) => compSetCrossfade(d, group, 40, tempo));
    const g = comp(get(), group);
    expect(g.crossfadeMs).toBe(40);
    expect(g.comp[0]!.fadeOut).toBeCloseTo(0.04, 2);
    // The borders did not move.
    expect(compSegmentsOf(g)).toEqual([
      { take: 0, from: 0, to: 1000 },
      { take: 2, from: 1000, to: 2000 },
      { take: 0, from: 2000, to: 7680 },
    ]);
    while (states.length > 1) {
      states.pop();
      expect(history.undo()).toBe(true);
      expect(get()).toEqual(states[states.length - 1]);
    }
  });

  it('flatten keeps what plays as plain clips and drops the take lanes', () => {
    const { history, get, group } = setup();
    history.transact('Comp', (d) => void compSwipe(d, group, 1, 1920, 3840, tempo));
    const before = get();
    const lanes = before.playlist.laneOrder.length;
    const playing = comp(before, group).comp.map((c) => [c.start, c.length, c.offsetSec, c.fadeIn, c.fadeOut]);
    history.transact('Flatten comp', (d) => void flattenComp(d, group));
    const p = get();
    expect(takeGroups(p)).toHaveLength(0);
    expect(p.playlist.laneOrder.length).toBe(lanes - 3);
    const clips = Object.values(p.playlist.clips) as AudioClip[];
    expect(clips.map((c) => [c.start, c.length, c.offsetSec, c.fadeIn, c.fadeOut])).toEqual(playing);
    expect(clips.every((c) => !c.take && !c.muted)).toBe(true);
    expect(history.undo()).toBe(true);
    expect(get()).toEqual(before);
  });
});

describe('repairing take tags', () => {
  const cloneJson = (p: Project) => JSON.parse(JSON.stringify(p));
  const repaired = (raw: unknown) => repairProject(migrateProject(raw).project);

  it('a good group survives a round trip through migrate', () => {
    const { get, group } = setup();
    const { project, repairs } = repaired(cloneJson(get()));
    expect(repairs).toEqual([]);
    expect(buildTakeGroups(project.playlist).find((g) => g.id === group)?.takes).toHaveLength(3);
  });

  it('damaged tags are dropped and a group that cannot work becomes ordinary tracks and clips', () => {
    const { get, group } = setup();
    const raw = cloneJson(get());
    const clips = Object.values(raw.playlist.clips) as Array<Record<string, unknown>>;
    (clips[0] as Record<string, unknown>).take = { group: 5, index: 'x' };
    const lane = Object.values(raw.playlist.lanes).find((l) => (l as Project['playlist']['lanes'][never]).takes?.role === 'take') as Record<string, unknown>;
    lane.takes = { group, role: 'sideways' };
    const { project, repairs } = repaired(raw);
    expect(repairs.join(' ')).toMatch(/take or comp mark/);
    const g = buildTakeGroups(project.playlist).find((x) => x.id === group);
    // The first take clip lost its tag, so two takes are left; the group still works.
    expect(g?.takes.map((t) => t.index)).toEqual([1, 2]);
    // Remove the comp lane's mark: the whole group is released.
    const raw2 = cloneJson(get());
    for (const l of Object.values(raw2.playlist.lanes) as Array<{ takes?: { role: string } }>) if (l.takes?.role === 'comp') delete l.takes;
    const out = repaired(raw2);
    expect(out.repairs.join(' ')).toMatch(/ordinary tracks and clips/);
    expect(buildTakeGroups(out.project.playlist)).toHaveLength(0);
    expect(Object.values(out.project.playlist.clips).every((c) => !('take' in c))).toBe(true);
    expect(Object.values(out.project.playlist.lanes).every((l) => !l.takes)).toBe(true);
  });
});
