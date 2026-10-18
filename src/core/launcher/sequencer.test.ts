import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { patchSlot } from '../ops/launcher';
import type { Project } from '../model/types';
import { launcherFixture } from './test-project';
import { LaunchSequencer, type PerformanceTake } from './sequencer';
import type { LaunchClock } from './run';

const BAR = 3840;
const BEAT = 960;

function setup(edit?: (p: Project, f: ReturnType<typeof launcherFixture>) => Project, random?: () => number) {
  const f = launcherFixture();
  let project = edit ? edit(f.project, f) : f.project;
  const takes: PerformanceTake[] = [];
  const seq = new LaunchSequencer({ project: () => project, ...(random ? { random } : {}), onTake: (t) => takes.push(t) });
  const [t1, t2] = f.tracks;
  const [s1, s2, s3] = f.scenes;
  return {
    f,
    seq,
    takes,
    t1: t1!,
    t2: t2!,
    s1: s1!,
    s2: s2!,
    s3: s3!,
    patch: (fn: (p: Project) => Project) => {
      project = fn(project);
    },
  };
}

/** A running transport: heard `heard`, nothing earlier than `heard + lead` can still change. */
const at = (heardU: number, lead = 120): LaunchClock => ({ playing: true, heardU, earliestU: heardU + lead });
const IDLE: LaunchClock = { playing: false, heardU: 0, earliestU: 0 };

describe('quantize boundaries', () => {
  it('lands on the next beat, bar, 2 bars or 4 bars after the heard position, never before the earliest schedulable tick', () => {
    const { seq } = setup();
    expect(seq.boundary('none', at(1000))).toBe(1120);
    expect(seq.boundary('beat', at(1000))).toBe(BEAT * 2);
    expect(seq.boundary('bar', at(1000))).toBe(BAR);
    expect(seq.boundary('2bars', at(1000))).toBe(BAR * 2);
    expect(seq.boundary('4bars', at(1000))).toBe(BAR * 4);
    // On the boundary exactly: this one.
    expect(seq.boundary('bar', at(BAR, 0))).toBe(BAR);
    // The boundary is too close to schedule (heard just before it, scheduler already past): the next one.
    expect(seq.boundary('bar', at(BAR - 10, 120))).toBe(BAR * 2);
    // Nothing running: it starts at once at 0.
    expect(seq.boundary('4bars', IDLE)).toBe(0);
  });

  it('grace: a boundary not yet heard but already inside the scheduler margin is still taken, within the grace', () => {
    const { seq } = setup();
    // Heard 10 ticks before the bar line; the scheduler is 120 ticks past its heard position; the grace reaches back 100 ticks from the clock.
    const clk = (lateU: number): LaunchClock => ({ playing: true, heardU: BAR - 10, earliestU: BAR + 110, lateU });
    expect(seq.boundary('bar', clk(BAR - 20))).toBe(BAR);
    expect(seq.boundary('bar', clk(BAR))).toBe(BAR); // exactly at the grace edge
    expect(seq.boundary('bar', clk(BAR + 1))).toBe(BAR * 2); // the boundary is further back than the grace
    expect(seq.boundary('beat', clk(BAR - 1))).toBe(BAR);
    // No lateU (a driver without the rule): the old behaviour.
    expect(seq.boundary('bar', { playing: true, heardU: BAR - 10, earliestU: BAR + 110 })).toBe(BAR * 2);
    // Already heard: never a boundary behind the heard position.
    expect(seq.boundary('bar', { playing: true, heardU: BAR + 5, earliestU: BAR + 110, lateU: 0 })).toBe(BAR * 2);
    // 'none' starts as soon as it can, grace or not.
    expect(seq.boundary('none', clk(0))).toBe(BAR + 110);
  });

  it('follows the time signature', () => {
    const { seq, patch } = setup();
    patch((p) => produce(p, (d) => void (d.transport.timeSig = { num: 3, den: 4 })));
    expect(seq.boundary('bar', at(1000))).toBe(3 * BEAT);
  });
});

describe('launching', () => {
  it('queues a slot for the next bar and plays it from there', () => {
    const { seq, t1, s1 } = setup();
    expect(seq.launch(t1, s1, at(1000))).toBe(BAR);
    expect(seq.runs).toHaveLength(1);
    expect(seq.runs[0]).toMatchObject({ trackId: t1, sceneId: s1, startU: BAR, endU: null, loop: true, passLength: BAR });
    expect(seq.stateOf(t1, s1, 1000).state).toBe('queued');
    expect(seq.stateOf(t1, s1, BAR).state).toBe('playing');
    expect(seq.stateOf(t1, seq.runs[0]!.sceneId, BAR + 99999).state).toBe('playing');
  });

  it('starts at once at tick 0 when nothing is running', () => {
    const { seq, t1, s1 } = setup();
    expect(seq.launch(t1, s1, IDLE)).toBe(0);
    expect(seq.runs[0]!.startU).toBe(0);
  });

  it('replaces a queued slot of the same track, and cuts the playing one where the new one starts', () => {
    const { seq, t1, s1, s2, s3 } = setup();
    seq.launch(t1, s1, at(0, 10));
    // s1 is queued for bar 1; pressing s2 before it starts replaces it.
    seq.launch(t1, s2, at(500));
    expect(seq.runs.map((r) => [r.sceneId, r.startU])).toEqual([[s2, BAR]]);
    // Once s2 plays, s3 is queued for the next bar and cuts it there.
    seq.launch(t1, s3, at(BAR + 500));
    expect(seq.runs.map((r) => [r.sceneId, r.startU, r.endU])).toEqual([
      [s2, BAR, BAR * 2],
      [s3, BAR * 2, null],
    ]);
    expect(seq.stateOf(t1, s2, BAR + 600).state).toBe('playing');
    expect(seq.stateOf(t1, s3, BAR + 600).state).toBe('queued');
    expect(seq.stateOf(t1, s2, BAR * 2).state).toBe('idle');
  });

  it('keeps one run per track and lets tracks play side by side', () => {
    const { seq, t1, t2, s1 } = setup();
    seq.launch(t1, s1, at(0));
    seq.launch(t2, s1, at(0));
    expect(seq.runs.map((r) => r.trackId).sort()).toEqual([t1, t2].sort());
    expect(new Set(seq.runs.map((r) => r.startU))).toEqual(new Set([BAR]));
  });

  it('ignores empty slots', () => {
    const { seq, t2, s3 } = setup();
    expect(seq.launch(t2, s3, at(0))).toBeNull();
    expect(seq.runs).toHaveLength(0);
  });

  it('a slot quantize of its own beats the grid’s', () => {
    const { seq, t1, s1, patch } = setup();
    patch((p) => produce(p, (d) => void patchSlot(d, t1, s1, { quantize: 'beat' })));
    expect(seq.launch(t1, s1, at(1000))).toBe(BEAT * 2);
  });

  it('a one-shot ends after one pass', () => {
    const { seq, t1, s1, patch } = setup();
    patch((p) => produce(p, (d) => void patchSlot(d, t1, s1, { loop: false })));
    seq.launch(t1, s1, at(0));
    expect(seq.runs[0]).toMatchObject({ startU: BAR, endU: BAR * 2, loop: false });
    expect(seq.stateOf(t1, s1, BAR * 2).state).toBe('idle');
  });

  it('a scene launches every track’s slot together, at the coarsest quantize among them', () => {
    const { seq, t1, t2, s1, patch } = setup();
    patch((p) => produce(p, (d) => void patchSlot(d, t2, s1, { quantize: '2bars' })));
    expect(seq.launchScene(s1, at(1000))).toBe(BAR * 2);
    expect(seq.runs.map((r) => [r.trackId, r.startU])).toEqual([
      [t1, BAR * 2],
      [t2, BAR * 2],
    ]);
  });

  it('a scene replaces what the tracks play', () => {
    const { seq, t1, t2, s1, s2 } = setup();
    seq.launchScene(s1, at(0));
    seq.launchScene(s2, at(BAR + 200));
    expect(seq.runs.filter((r) => r.trackId === t1).map((r) => [r.sceneId, r.startU, r.endU])).toEqual([
      [s1, BAR, BAR * 2],
      [s2, BAR * 2, null],
    ]);
    expect(seq.runs.filter((r) => r.trackId === t2)).toHaveLength(2);
  });
});

describe('modes', () => {
  it('trigger: a second press does nothing, and cancels a stop', () => {
    const { seq, t1, s1 } = setup();
    seq.launch(t1, s1, at(0));
    const before = seq.runs;
    expect(seq.launch(t1, s1, at(BAR + 100))).toBeNull();
    expect(seq.runs).toBe(before);
    seq.stopTrack(t1, at(BAR + 100));
    expect(seq.stateOf(t1, s1, BAR + 100).state).toBe('stopping');
    seq.launch(t1, s1, at(BAR + 200));
    expect(seq.stateOf(t1, s1, BAR + 200).state).toBe('playing');
    expect(seq.runs[0]!.endU).toBeNull();
  });

  it('toggle: the second press stops it at the boundary', () => {
    const { seq, t1, s1, patch } = setup();
    patch((p) => produce(p, (d) => void patchSlot(d, t1, s1, { mode: 'toggle' })));
    seq.launch(t1, s1, at(0));
    seq.launch(t1, s1, at(BAR + 100));
    expect(seq.runs[0]).toMatchObject({ startU: BAR, endU: BAR * 2, stopU: BAR * 2 });
    // A third press (it is stopping) starts it again.
    seq.launch(t1, s1, at(BAR + 200));
    expect(seq.runs.at(-1)!.startU).toBe(BAR * 2);
  });

  it('toggle: a press while it is only queued takes it back', () => {
    const { seq, t1, s1, patch } = setup();
    patch((p) => produce(p, (d) => void patchSlot(d, t1, s1, { mode: 'toggle' })));
    seq.launch(t1, s1, at(0));
    seq.launch(t1, s1, at(100));
    expect(seq.runs).toHaveLength(0);
  });

  it('gate: letting go stops it at the boundary', () => {
    const { seq, t1, s1, patch } = setup();
    patch((p) => produce(p, (d) => void patchSlot(d, t1, s1, { mode: 'gate', quantize: 'beat' })));
    seq.launch(t1, s1, at(1000));
    expect(seq.runs[0]!.startU).toBe(BEAT * 2);
    seq.release(t1, s1, at(BEAT * 2 + 100));
    expect(seq.runs[0]).toMatchObject({ endU: BEAT * 3, stopU: BEAT * 3 });
  });

  it('gate: let go before it started, it never plays', () => {
    const { seq, t1, s1, patch } = setup();
    patch((p) => produce(p, (d) => void patchSlot(d, t1, s1, { mode: 'gate' })));
    seq.launch(t1, s1, at(100));
    seq.release(t1, s1, at(200));
    expect(seq.runs).toHaveLength(0);
  });

  it('release does nothing for other modes', () => {
    const { seq, t1, s1 } = setup();
    seq.launch(t1, s1, at(0));
    const before = seq.runs;
    seq.release(t1, s1, at(10));
    expect(seq.runs).toBe(before);
  });

  it('retrigger: every press restarts it at the next boundary', () => {
    const { seq, t1, s1, patch } = setup();
    patch((p) => produce(p, (d) => void patchSlot(d, t1, s1, { mode: 'retrigger' })));
    seq.launch(t1, s1, at(0));
    seq.launch(t1, s1, at(BAR + 100));
    expect(seq.runs.map((r) => [r.startU, r.endU])).toEqual([
      [BAR, BAR * 2],
      [BAR * 2, null],
    ]);
  });
});

describe('stopping', () => {
  it('stops a track at the boundary and drops what was queued on it', () => {
    const { seq, t1, t2, s1, s2 } = setup();
    seq.launch(t1, s1, at(0));
    seq.launch(t2, s1, at(0));
    seq.launch(t1, s2, at(BAR + 100));
    seq.stopTrack(t1, at(BAR + 200));
    expect(seq.runs.filter((r) => r.trackId === t1).map((r) => [r.sceneId, r.endU, r.stopU])).toEqual([[s1, BAR * 2, BAR * 2]]);
    expect(seq.runs.find((r) => r.trackId === t2)!.endU).toBeNull();
  });

  it('stop all stops every track at the grid’s quantize, or at once', () => {
    const { seq, t1, t2, s1 } = setup();
    seq.launch(t1, s1, at(0));
    seq.launch(t2, s1, at(0));
    seq.stopAll(at(BAR + 100));
    expect(seq.runs.map((r) => r.endU)).toEqual([BAR * 2, BAR * 2]);
    seq.stopAll(at(BAR + 100), true);
    expect(seq.runs.map((r) => r.endU)).toEqual([BAR + 220, BAR + 220]);
  });

  it('is idle once every run has ended', () => {
    const { seq, t1, s1 } = setup();
    seq.launch(t1, s1, at(0));
    expect(seq.idleAt(0)).toBe(false);
    seq.stopTrack(t1, at(BAR + 10));
    expect(seq.idleAt(BAR * 2 - 1)).toBe(false);
    expect(seq.idleAt(BAR * 2)).toBe(true);
  });

  it('reset forgets the runs', () => {
    const { seq, t1, s1 } = setup();
    seq.launch(t1, s1, at(0));
    seq.reset();
    expect(seq.runs).toHaveLength(0);
  });
});

describe('follow actions', () => {
  it('stop: ends the run after the bars', () => {
    const { seq, t1, s1, patch } = setup();
    patch((p) => produce(p, (d) => void patchSlot(d, t1, s1, { follow: { kind: 'stop', bars: 2 } })));
    seq.launch(t1, s1, at(0));
    expect(seq.runs[0]).toMatchObject({ startU: BAR, endU: BAR * 3 });
  });

  it('next: hands over to the next scene’s slot of the track a bar ahead, wrapping and skipping empty slots', () => {
    const { seq, t1, t2, s1, s2, patch } = setup();
    patch((p) => produce(p, (d) => void patchSlot(d, t2, s2, { follow: { kind: 'next', bars: 2 } })));
    patch((p) => produce(p, (d) => void patchSlot(d, t2, s1, { follow: { kind: 'next', bars: 1 } })));
    void t1;
    seq.launch(t2, s2, at(0));
    // Not within a bar of the hand-over yet.
    seq.advance(at(BAR, 120));
    expect(seq.runs).toHaveLength(1);
    // Within a bar of it (bar 3 is where s2 hands over): next of s2 on track 2 is s1 (s3 is empty there, the grid wraps).
    seq.advance(at(BAR * 2 + 100));
    expect(seq.runs.map((r) => [r.sceneId, r.startU, r.endU])).toEqual([
      [s2, BAR, BAR * 3],
      [s1, BAR * 3, null],
    ]);
    // Again: no second hand-over.
    seq.advance(at(BAR * 2 + 200));
    expect(seq.runs).toHaveLength(2);
    // s1 hands over after one bar: a bar ahead of bar 4 is now, so s2 follows at bar 4.
    seq.advance(at(BAR * 3 + 100));
    expect(seq.runs.map((r) => [r.sceneId, r.startU])).toEqual([
      [s2, BAR],
      [s1, BAR * 3],
      [s2, BAR * 4],
    ]);
  });

  it('random: picks another filled slot of the track', () => {
    const { seq, t1, s1, s2, s3, patch } = setup(undefined, () => 0.99);
    patch((p) => produce(p, (d) => void patchSlot(d, t1, s1, { follow: { kind: 'random', bars: 1 } })));
    seq.launch(t1, s1, at(0));
    seq.advance(at(BAR + 100));
    expect(seq.runs.at(-1)).toMatchObject({ sceneId: s3, startU: BAR * 2 });
    void s2;
  });

  it('a press that queued something else wins over the follow action', () => {
    const { seq, t1, s1, s2, patch } = setup();
    patch((p) => produce(p, (d) => void patchSlot(d, t1, s1, { follow: { kind: 'next', bars: 2 } })));
    seq.launch(t1, s1, at(0));
    seq.launch(t1, s2, at(BAR * 2 + 100));
    seq.advance(at(BAR * 2 + 200));
    expect(seq.runs.filter((r) => r.sceneId === s2)).toHaveLength(1);
    expect(seq.runs).toHaveLength(2);
  });
});

describe('the performance record', () => {
  it('keeps what played between its start and end, clipped, and hands it over when the music gets to the end', () => {
    const { seq, takes, t1, t2, s1, s2 } = setup();
    seq.launch(t1, s1, at(0)); // plays from bar 1 on
    seq.startRecording(at(BAR + 200)); // starts at bar 2
    expect(seq.recording).toBe(true);
    seq.launch(t2, s1, at(BAR * 2 + 100)); // from bar 3
    seq.launch(t1, s2, at(BAR * 3 + 100)); // t1: s1 until bar 4, then s2
    seq.stopRecording(at(BAR * 4 + 100)); // ends at bar 5
    seq.advance(at(BAR * 4 + 200));
    expect(takes).toHaveLength(0);
    seq.advance(at(BAR * 5));
    expect(takes).toHaveLength(1);
    const take = takes[0]!;
    expect([take.startU, take.endU]).toEqual([BAR * 2, BAR * 5]);
    expect(take.entries.map((e) => [e.trackId === t1 ? 't1' : 't2', e.sceneId === s1 ? 's1' : 's2', e.startU, e.endU, e.phase])).toEqual([
      ['t1', 's1', BAR * 2, BAR * 4, 0],
      ['t2', 's1', BAR * 3, BAR * 5, 0],
      ['t1', 's2', BAR * 4, BAR * 5, 0],
    ]);
    expect(seq.recording).toBe(false);
  });

  it('a record that is still going when the transport stops ends where the music did', () => {
    const { seq, takes, t1, s1 } = setup();
    seq.startRecording(IDLE);
    seq.launch(t1, s1, IDLE);
    seq.advance(at(BAR * 2 + 500));
    seq.reset();
    expect(takes).toHaveLength(1);
    expect(takes[0]!.entries[0]).toMatchObject({ startU: 0, endU: BAR * 2 + 500 });
  });

  it('records nothing when nothing was launched', () => {
    const { seq, takes } = setup();
    seq.startRecording(at(0));
    seq.stopRecording(at(10));
    seq.advance(at(BAR * 2));
    expect(takes).toHaveLength(0);
  });
});
