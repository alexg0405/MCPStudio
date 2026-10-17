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
