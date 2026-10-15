import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createEmptyProject } from '@core/model/defaults';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { MASTER, type ClipId, type LaneId, type PatternId, type SlotId } from '@core/model/types';
import { addMarker } from '@core/ops/markers';
import {
  busiestWindow,
  LEVEL_TARGETS,
  levelMoves,
  limiterInput,
  PRE_LIMITER_LUFS,
  tameMasterClipper,
  type BusLevel,
} from './auto-level';

const dbOf = (g: number) => 20 * Math.log10(g);
const sum = (lufs: number[]) => 10 * Math.log10(lufs.reduce((a, l) => a + Math.pow(10, l / 10), 0));

describe('level math', () => {
  const buses: BusLevel[] = [
    { role: 'kick', lufs: -14, gain: 1 },
    { role: 'drums', lufs: -18, gain: 0.8 },
    { role: 'bass', lufs: -19, gain: 0.8 },
    { role: 'chords', lufs: -15, gain: 0.5 },
    { role: 'lead', lufs: -30, gain: 0.7 },
  ];

  it('puts every bus at its style level around the kick, then trims all together to −16 LUFS', () => {
    const plan = levelMoves(buses, 'trap');
    const t = LEVEL_TARGETS.trap;
    const by = Object.fromEntries(plan.moves.map((m) => [m.role, m]));
    const kick = by.kick!.lufs;
    expect(by.drums!.lufs - kick).toBeCloseTo(t.drums, 9);
    expect(by.bass!.lufs - kick).toBeCloseTo(t.bass, 9);
    expect(by.chords!.lufs - kick).toBeCloseTo(t.chords, 9);
    // The lead would need +16 dB: one leveling moves a fader by at most +6 dB.
    expect(by.lead!.lufs - by.lead!.from).toBeDefined();
    expect(dbOf(by.lead!.to) - dbOf(by.lead!.from) - plan.trimDb).toBeCloseTo(6, 9);
    expect(sum(plan.moves.map((m) => m.lufs))).toBeCloseTo(PRE_LIMITER_LUFS, 6);
    expect(plan.sumLufs).toBeCloseTo(PRE_LIMITER_LUFS, 6);
    // A fader's loudness follows its gain exactly.
    for (const m of plan.moves) expect(m.lufs - buses.find((b) => b.role === m.role)!.lufs).toBeCloseTo(dbOf(m.to) - dbOf(m.from), 9);
  });

  it('clamps moves to −12 dB and stops faders at +5.6 dB', () => {
    const plan = levelMoves(
      [
        { role: 'kick', lufs: -30, gain: 1 },
        { role: 'drums', lufs: -5, gain: 1 },
      ],
      'boombap',
    );
    const by = Object.fromEntries(plan.moves.map((m) => [m.role, m]));
    expect(dbOf(by.drums!.to) - dbOf(by.drums!.from) - plan.trimDb).toBeCloseTo(-12, 9);
    for (const m of plan.moves) expect(m.to).toBeLessThanOrEqual(MAX_INSERT_VOLUME + 1e-12);
    // A quiet mix can't be lifted past the faders' top: the kick sits at +5.6 dB.
    const quiet = levelMoves([{ role: 'kick', lufs: -40, gain: 1 }], 'trap');
    expect(quiet.moves[0]!.to).toBeCloseTo(MAX_INSERT_VOLUME, 9);
  });

  it('leaves the faders the AI set alone, and counts them in the sum', () => {
    const plan = levelMoves(
      buses.map((b) => (b.role === 'lead' ? { ...b, pinned: true } : b)),
      'pop',
    );
    const lead = plan.moves.find((m) => m.role === 'lead')!;
    expect(lead.to).toBe(lead.from);
    expect(sum(plan.moves.map((m) => m.lufs))).toBeCloseTo(PRE_LIMITER_LUFS, 6);
  });

  it('measures against the drums when there is no kick, and skips silent buses', () => {
    const plan = levelMoves(
      [
        { role: 'drums', lufs: -20, gain: 1 },
        { role: 'bass', lufs: -20, gain: 1 },
        { role: 'fx', lufs: -Infinity, gain: 1 },
      ],
      'house',
    );
    expect(plan.moves.map((m) => m.role)).toEqual(['drums', 'bass']);
    const [drums, bass] = plan.moves;
    expect(bass!.lufs - drums!.lufs).toBeCloseTo(LEVEL_TARGETS.house.bass - LEVEL_TARGETS.house.drums, 9);
    expect(levelMoves([], 'trap').moves).toEqual([]);
  });

  it('sets the Limiter input from −16 LUFS to the style’s loudness, 0…10 dB', () => {
    expect(limiterInput('trap')).toBe(6);
    expect(limiterInput('house')).toBe(6.5);
    expect(limiterInput('boombap')).toBe(5);
    expect(limiterInput('lofi')).toBe(3);
    expect(limiterInput('pop', -10)).toBe(0);
    expect(limiterInput('trap', -30)).toBe(10);
  });
});

describe('the part auto-level listens to', () => {
  const BAR = 3840;

  it('is the busiest section, at most 8 bars', () => {
    let p = createEmptyProject();
    const pid = p.patternOrder[0] as PatternId;
    p = produce(p, (d) => {
      const lane = d.playlist.laneOrder[0] as LaneId;
      const lane2 = d.playlist.laneOrder[1] as LaneId;
      d.channelOrder.push('ch_a' as never, 'ch_b' as never);
      d.channels['ch_a' as never] = { kind: 'instrument', id: 'ch_a', name: 'A', color: '#000', muted: false, solo: false, volume: 0.78, pan: 0, output: 'ins_master', rootKey: 60, plugin: { pluginId: 'x', pluginVersion: 1, params: {} } } as never;
      d.channels['ch_b' as never] = { ...(d.channels['ch_a' as never] as object), id: 'ch_b', name: 'B' } as never;
      d.patterns[pid]!.notes['ch_a' as never] = { n: { id: 'n', tick: 0, length: 240, key: 60, velocity: 1 } } as never;
      const pid2 = 'pat_2' as PatternId;
      d.patterns[pid2] = { id: pid2, name: 'Drop', color: '#fff', stepCount: 16, notes: { ['ch_a' as never]: { n: { id: 'n', tick: 0, length: 240, key: 60, velocity: 1 } }, ['ch_b' as never]: { m: { id: 'm', tick: 0, length: 240, key: 60, velocity: 1 } } } } as never;
      d.patternOrder.push(pid2);
      for (let bar = 0; bar < 24; bar++)
        d.playlist.clips[`c${bar}` as ClipId] = { kind: 'pattern', id: `c${bar}` as ClipId, laneId: bar >= 8 && bar < 20 ? lane2 : lane, start: bar * BAR, length: BAR, patternId: bar >= 8 && bar < 20 ? pid2 : pid, offset: 0 } as never;
      addMarker(d, 0, 'Intro');
      addMarker(d, 8 * BAR, 'Drop');
      addMarker(d, 20 * BAR, 'Outro');
    });
    expect(busiestWindow(p, null)).toEqual({ mode: 'song', patternId: null, fromTick: 8 * BAR, bars: 8 });
    expect(busiestWindow(p, null, 2 * BAR, 4)).toEqual({ mode: 'song', patternId: null, fromTick: 2 * BAR, bars: 4 });
    // No song: the current pattern on a loop.
    const empty = produce(p, (d) => {
      d.playlist.clips = {};
    });
    expect(busiestWindow(empty, pid)).toMatchObject({ mode: 'pattern', patternId: pid, fromTick: 0, bars: 8 });
    expect(busiestWindow(empty, null)).toBeNull();
  });
});

describe('taming a hard clipper on the master', () => {
  it('turns it into tape at 3 dB drive at most, and leaves other saturators alone', () => {
    const base = createEmptyProject();
    const p = produce(base, (d) => {
      const fx = d.mixer.inserts[MASTER]!.fx;
      fx.push({ id: 'sat' as SlotId, plugin: { pluginId: 'agstudio.saturator', pluginVersion: 1, params: { mode: 'clip', drive: 4 } }, enabled: true, mix: 1, sidechain: null });
      fx.push({ id: 'tape' as SlotId, plugin: { pluginId: 'agstudio.saturator', pluginVersion: 1, params: { mode: 'tape', drive: 6 } }, enabled: true, mix: 1, sidechain: null });
    });
    let changes: string[] = [];
    const out = produce(p, (d) => {
      changes = tameMasterClipper(d);
    });
    const [clip, tape] = out.mixer.inserts[MASTER]!.fx;
    expect(clip!.plugin.params).toMatchObject({ mode: 'tape', drive: 3 });
    expect(tape!.plugin.params).toMatchObject({ mode: 'tape', drive: 6 });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/hard clip → tape/);
  });
});
