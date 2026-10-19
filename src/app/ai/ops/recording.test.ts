import { describe, expect, it } from 'vitest';
import { tempoMapOf } from '@core/automation/tempo';
import type { AudioClipChannel, SampleId } from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { addTakeGroup, compSegmentsOf, newTakeGroup } from '@core/ops/comp';
import { takeGroups } from '@core/query/takes';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';

const BAR = 3840;

/** A recording of three takes of the same 4 bars (the takes' audio is 8 s apart in the recording). */
function withTakes() {
  const s = createTestServices();
  const group = newTakeGroup();
  s.history.transact('record', (d) => {
    addSample(d, { id: 'smp' as SampleId, name: 'rec', source: { kind: 'builtin', generator: 'x', version: 1 } });
    const ch: AudioClipChannel = {
      kind: 'audioClip',
      id: 'ch_rec' as AudioClipChannel['id'],
      name: 'Recording 1',
      color: '#fff',
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      output: 'master' as never,
      sampleId: 'smp' as SampleId,
    };
    addChannel(d, ch);
    addTakeGroup(d, {
      group,
      name: 'Recording 1',
      channelId: ch.id,
      takes: [0, 1, 2].map((i) => ({ start: BAR * 4, length: BAR * 4, offsetSec: i * 8 })),
      audible: 2,
      first: 0,
      tempo: tempoMapOf(d as never, 'song'),
    });
  });
  return { s, group };
}
const run = (s: ReturnType<typeof createTestServices>, actions: AiAction[]) =>
  applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const segs = (s: ReturnType<typeof createTestServices>) => compSegmentsOf(takeGroups(s.doc.getState().project)[0]!).map((x) => [x.take, x.from / BAR + 1, x.to / BAR + 1]);

describe('comp action', () => {
  it('uses a take for some bars, promotes a take, steps to the next and previous take: each one undo step', () => {
    const { s } = withTakes();
    const depth = () => s.history.status().cursor;
    const start = depth();
    // The comp starts as the newest take (take 3 = index 2).
    expect(segs(s)).toEqual([[2, 5, 9]]);
    let res = run(s, [{ op: 'comp', action: 'use_take', take: 1, from_bar: 6, to_bar: 7 }]);
    expect(res.warnings).toEqual([]);
    expect(res.changes).toEqual(['Comp “Recording 1”: take 1 plays bars 6–7']);
    expect(segs(s)).toEqual([[2, 5, 6], [0, 6, 8], [2, 8, 9]]);
    expect(depth()).toBe(start + 1);
    res = run(s, [{ op: 'comp', action: 'next', from_bar: 6, to_bar: 7 }]);
    expect(res.changes).toEqual(['Comp “Recording 1”: take 2 plays bars 6–7']);
    expect(segs(s)).toEqual([[2, 5, 6], [1, 6, 8], [2, 8, 9]]);
    run(s, [{ op: 'comp', action: 'previous', from_bar: 6, to_bar: 7 }]);
    expect(segs(s)[1]).toEqual([0, 6, 8]);
    run(s, [{ op: 'comp', action: 'promote', take: 2 }]);
    expect(segs(s)).toEqual([[1, 5, 9]]);
    expect(depth()).toBe(start + 4);
    // Undo puts the comp back one step at a time.
    s.history.undo();
    expect(segs(s)).toEqual([[2, 5, 6], [0, 6, 8], [2, 8, 9]]);
  });

  it('sets the crossfade, and flattens to plain clips', () => {
    const { s } = withTakes();
    run(s, [{ op: 'comp', action: 'use_take', take: 1, from_bar: 6, to_bar: 6 }]);
    run(s, [{ op: 'comp', action: 'crossfade', ms: 25 }]);
    expect(takeGroups(s.doc.getState().project)[0]!.crossfadeMs).toBe(25);
    expect(segs(s)).toEqual([[2, 5, 6], [0, 6, 7], [2, 7, 9]]);
    const res = run(s, [{ op: 'comp', action: 'flatten' }]);
    expect(res.changes[0]).toMatch(/^Flattened “Recording 1”: the comp stays as ordinary clips and 3 take tracks went$/);
    expect(takeGroups(s.doc.getState().project)).toHaveLength(0);
  });

  it('explains what it cannot do', () => {
    const { s } = withTakes();
    expect(run(s, [{ op: 'comp', action: 'use_take', take: 9 }]).warnings).toEqual(['comp: “Recording 1” has 3 takes: there is no take 9']);
    expect(run(s, [{ op: 'comp', action: 'use_take' }]).warnings).toEqual(['comp: which take? (the 1-based take number from get_takes)']);
    expect(run(s, [{ op: 'comp', action: 'use_take', take: 1, from_bar: 50 }]).warnings[0]).toMatch(/take 1 has no audio in bar 50/);
    expect(run(s, [{ op: 'comp', action: 'use_take', take: 1, group: 'nope' }]).warnings).toEqual(['comp: there is no take group "nope" (get_takes lists them)']);
    const bare = createTestServices();
    expect(run(bare, [{ op: 'comp', action: 'flatten' }]).warnings).toEqual(['comp: there are no takes to comp (loop-record audio first)']);
  });
});

/** `withTakes` plus a second recording of the same 4 bars (two takes, on the tracks after the first one's). */
function withTwoRecordings() {
  const { s, group } = withTakes();
  const second = newTakeGroup();
  s.history.transact('record 2', (d) => {
    addSample(d, { id: 'smp2' as SampleId, name: 'rec2', source: { kind: 'builtin', generator: 'x', version: 1 } });
    const ch: AudioClipChannel = {
      kind: 'audioClip',
      id: 'ch_rec2' as AudioClipChannel['id'],
      name: 'Recording 2',
      color: '#fff',
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      output: 'master' as never,
      sampleId: 'smp2' as SampleId,
    };
    addChannel(d, ch);
    addTakeGroup(d, {
      group: second,
      name: 'Recording 2',
      channelId: ch.id,
      takes: [0, 1].map((i) => ({ start: BAR * 4, length: BAR * 4, offsetSec: 20 + i * 8 })),
      audible: 1,
      first: 4,
      tempo: tempoMapOf(d as never, 'song'),
    });
  });
  return { s, group, second };
}

describe('comp action: add_takes', () => {
  it('moves the takes of another recording into a comp, one undo step; the comp can then play them', () => {
    const { s, group, second } = withTwoRecordings();
    const before = s.doc.getState().project;
    const r = run(s, [{ op: 'comp', action: 'add_takes', group: second, into_group: group }]);
    expect(r.changes[0]).toBe('Added the 2 takes of “Recording 2” to the comp of “Recording 1”');
    expect(takeGroups(s.doc.getState().project).map((g) => g.takes.length)).toEqual([5]);
    // Take 4 is the other recording's first take.
    run(s, [{ op: 'comp', action: 'use_take', take: 4, from_bar: 6, to_bar: 6 }]);
    const g = takeGroups(s.doc.getState().project)[0]!;
    expect(g.comp.map((c) => c.channelId)).toEqual(['ch_rec', 'ch_rec2', 'ch_rec']);
    s.history.undo();
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
  });

  it('the default is the recording that overlaps; warnings say why it cannot', () => {
    const { s, second } = withTwoRecordings();
    expect(run(s, [{ op: 'comp', action: 'add_takes', group: second }]).changes[0]).toMatch(/^Added the 2 takes of “Recording 2” to the comp of “Recording 1”$/);
    const lone = withTakes().s;
    expect(run(lone, [{ op: 'comp', action: 'add_takes' }]).warnings).toEqual(['comp: no other recording overlaps these takes in time (give into_group or into_track)']);
    expect(run(s, [{ op: 'comp', action: 'add_takes', into_group: 'nope' }]).warnings[0]).toMatch(/there is no take group "nope"/);
  });

  it('get_takes lists which groups overlap, and which recording each take came from after the merge', () => {
    const { s, group, second } = withTwoRecordings();
    const read = () => (runReadTool(s, 'get_takes') as { groups: Array<{ group: string; overlaps_groups: string[]; takes: Array<{ recording?: string }> }> }).groups;
    expect(read().map((g) => [g.group, g.overlaps_groups])).toEqual([
      [group, [second]],
      [second, [group]],
    ]);
    run(s, [{ op: 'comp', action: 'add_takes', group: second }]);
    expect(read()).toHaveLength(1);
    expect(read()[0]!.takes.map((t) => t.recording)).toEqual(['Recording 1', 'Recording 1', 'Recording 1', 'Recording 2', 'Recording 2']);
  });
});

describe('get_takes', () => {
  it('lists the takes, the comp, the punch range and the recording settings in the units the actions take', () => {
    const { s, group } = withTakes();
    run(s, [{ op: 'comp', action: 'use_take', take: 2, from_bar: 7, to_bar: 8 }]);
    s.view.getState().setPunch({ start: BAR * 4, end: BAR * 8 });
    const r = runReadTool(s, 'get_takes') as {
      groups: Array<{ group: string; name: string; comp_track: number; take_tracks: number[]; takes: unknown[]; comp: unknown[]; takes_open: boolean }>;
      punch: unknown;
      recording: Record<string, unknown>;
    };
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]).toMatchObject({ group, name: 'Recording 1', comp_track: 1, take_tracks: [2, 3, 4], takes_open: false });
    expect(r.groups[0]!.takes).toHaveLength(3);
    expect(r.groups[0]!.comp).toEqual([
      { take: 3, bar: 5, bars: 2 },
      { take: 2, bar: 7, bars: 2 },
    ]);
    expect(r.punch).toEqual({ from_bar: 5, to_bar: 8 });
    expect(r.recording).toMatchObject({ record_mode_armed: false, pre_roll_bars: 1 });
  });

  it('says which take the musician is listening to on its own', () => {
    const { s } = withTakes();
    const g = takeGroups(s.doc.getState().project)[0]!;
    const listening = () => (runReadTool(s, 'get_takes') as { groups: Array<{ listening_to_take: number | null }> }).groups[0]!.listening_to_take;
    expect(listening()).toBeNull();
    s.editor.getState().setAuditionTake(g.takes[1]!.clips[0]!.id);
    expect(listening()).toBe(2);
  });
});

describe('a recording keeps its own tracks (the AI cannot put anything on them)', () => {
  it('place_pattern refuses a comp or take track and otherwise skips them; clip edit will not move a take or onto them', () => {
    const { s } = withTakes();
    const p = s.doc.getState().project;
    const name = p.patterns[p.patternOrder[0]!]!.name;
    const clipsOnTracks = () => Object.values(s.doc.getState().project.playlist.clips).filter((c) => c.kind === 'pattern');
    let res = run(s, [{ op: 'place_pattern', pattern: name, bar: 1, track: 1 }]);
    expect(res.warnings.join(' ')).toMatch(/belongs to a recording's takes/);
    expect(clipsOnTracks()).toHaveLength(0);
    res = run(s, [{ op: 'place_pattern', pattern: name, bar: 5 }]);
    expect(res.warnings).toEqual([]);
    const placed = clipsOnTracks()[0]!;
    // Tracks 1-4 hold the comp and three takes: the pattern goes to the first one after them.
    expect(s.doc.getState().project.playlist.laneOrder.indexOf(placed.laneId)).toBe(4);
    res = run(s, [{ op: 'clip', action: 'edit', track: 2, bar: 5, to_track: 7 }]);
    expect(res.warnings.join(' ')).toMatch(/keep only that recording/);
    res = run(s, [{ op: 'clip', action: 'edit', track: 5, bar: 5, to_track: 1 }]);
    expect(res.warnings.join(' ')).toMatch(/keep only that recording/);
  });

  it('moving a take clip with the AI moves what the comp plays of it, in the same undo step', () => {
    const { s } = withTakes();
    run(s, [{ op: 'comp', action: 'use_take', take: 1 }]);
    expect(segs(s)).toEqual([[0, 5, 9]]);
    const before = s.history.status().cursor;
    const res = run(s, [{ op: 'clip', action: 'edit', track: 4, bar: 5, to_bar: 6 }]);
    expect(res.warnings).toEqual([]);
    expect(s.history.status().cursor).toBe(before + 1);
    // Take 1 (the oldest, on the lowest take track) started at bar 5 and now at bar 6; the comp's part of it moved too.
    expect(segs(s)).toEqual([[0, 6, 10]]);
    const g = takeGroups(s.doc.getState().project)[0]!;
    const take1 = g.takes.find((t) => t.index === 0)!.clips[0]!;
    expect(take1.start).toBe(BAR * 5);
    expect(g.comp.some((c) => c.take?.index === 0 && c.start >= BAR * 5)).toBe(true);
    s.history.undo();
    expect(takeGroups(s.doc.getState().project)[0]!.takes.find((t) => t.index === 0)!.clips[0]!.start).toBe(BAR * 4);
  });
});

describe('record action', () => {
  it('sets the punch range, count-in and pre-roll, then starts from the pre-roll before the punch-in', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'record', action: 'set_punch', punch_from_bar: 9, punch_to_bar: 12, count_in_bars: 2, pre_roll_bars: 2 },
      { op: 'record', action: 'start' },
    ]);
    expect(res.warnings).toEqual([]);
    expect(s.view.getState().punch).toEqual({ start: BAR * 8, end: BAR * 12 });
    expect(s.prefs.getState()).toMatchObject({ countInBars: 2, preRollBars: 2, recordAudio: true });
    expect(res.after).toEqual([{ kind: 'play', mode: 'song', record: true, fromTick: BAR * 6 }]);
    expect(res.ui?.join(' ')).toMatch(/punch range bars 9–12/);
    run(s, [{ op: 'record', action: 'clear_punch' }]);
    expect(s.view.getState().punch).toBeNull();
    expect(run(s, [{ op: 'record', action: 'stop' }]).after).toEqual([{ kind: 'stop' }]);
  });

  it('arms and disarms audio record mode, and says what it cannot read', () => {
    const s = createTestServices();
    run(s, [{ op: 'record', action: 'arm' }]);
    expect(s.recording.armed).toBe(true);
    expect(s.prefs.getState().recordAudio).toBe(true);
    run(s, [{ op: 'record', action: 'disarm' }]);
    expect(s.recording.armed).toBe(false);
    expect(run(s, [{ op: 'record', action: 'set_punch' }]).warnings).toEqual(['record: set_punch needs punch_from_bar']);
  });
});
