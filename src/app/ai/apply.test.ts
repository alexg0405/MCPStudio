import { describe, expect, it } from 'vitest';
import { MASTER, type ChannelId, type InsertId } from '@core/model/types';
import { createTestServices } from '../testing';
import { resolveTarget } from '@core/automation/targets';
import { applyAnswer, coerceParam, parseKey } from './apply';
import { ACTIONS_SCHEMA, readAnswer, type AiAction } from './schema';
import { p } from '@agstudio/sdk';

const run = (s: ReturnType<typeof createTestServices>, actions: AiAction[], message = 'ok') =>
  applyAnswer(s, { message, actions }, { previousBeat: null });

describe('AI actions', () => {
  it('builds a channel, a mixer track with effects and routing in one undo step', () => {
    const s = createTestServices();
    const before = s.doc.getState().project;
    const res = run(s, [
      { op: 'song', bpm: 142, key: 'F minor', swing: 10 },
      {
        op: 'add_channel',
        ref: '@lead',
        plugin: 'agstudio.3xosc',
        name: 'Lead',
        params: [
          { name: 'cutoff', value: 1200 },
          { name: 'osc1Wave', value: 'square' },
          { name: 'sustain', value: 50 }, // "50" → 0.5 (a % param)
          { name: 'nope', value: 1 },
        ],
        volume_db: -6,
      },
      { op: 'add_insert', ref: '@bus', name: 'Lead bus' },
      { op: 'edit_channel', channel: '@lead', insert: '@bus', pan: -0.3 },
      { op: 'add_effect', ref: '@verb', insert: '@bus', plugin: 'agstudio.reverb', preset: 'Hall', mix: 0.25 },
      { op: 'add_effect', insert: '@bus', plugin: 'agstudio.delay', params: [{ name: 'time', value: '1/8d' }] },
      { op: 'edit_insert', insert: '@bus', volume_db: -3 },
      { op: 'route', from: '@bus', to: '2', level_db: -6 },
    ]);
    const project = s.doc.getState().project;
    expect(res.edited).toBe(true);
    expect(res.warnings).toEqual(['3xOsc has no setting "nope"']);
    expect(project.transport).toMatchObject({ bpm: 142, swing: 0.1, key: { root: 5, scale: 'minor' } });
    const lead = Object.values(project.channels).find((c) => c.name === 'Lead')!;
    expect(lead.kind).toBe('instrument');
    if (lead.kind !== 'instrument') return;
    expect(lead.plugin.params).toMatchObject({ cutoff: 1200, osc1Wave: 'square', sustain: 0.5 });
    expect(lead.volume).toBeCloseTo(10 ** (-6 / 20), 6);
    expect(lead.pan).toBe(-0.3);
    const bus = project.mixer.inserts[lead.output]!;
    expect(bus.name).toBe('Lead bus');
    expect(bus.volume).toBeCloseTo(10 ** (-3 / 20), 6);
    expect(bus.fx.map((f) => f.plugin.pluginId)).toEqual(['agstudio.reverb', 'agstudio.delay']);
    expect(bus.fx[0]).toMatchObject({ mix: 0.25, plugin: { params: { decay: 3.2 } } }); // the Hall preset
    expect(bus.fx[1]!.plugin.params.time).toBe('1/8d');
    expect(bus.routes).toEqual([
      { to: MASTER, level: 1, pre: false },
      { to: project.mixer.order[2], level: expect.closeTo(0.501, 3), pre: false },
    ]);
    // All of it is one undo step.
    s.history.undo();
    expect(s.doc.getState().project).toEqual(before);
  });

  it('skips what it cannot do and says why', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'edit_channel', channel: 'Theremin', volume_db: -3 },
      { op: 'add_effect', insert: '99', plugin: 'agstudio.eq' },
      { op: 'add_effect', insert: '1', plugin: 'agstudio.3xosc' },
      { op: 'sidechain', effect: 'fx_none', from: '1' },
      { op: 'remove_insert', insert: 'master' },
      { op: 'song', bpm: 99 },
    ]);
    expect(res.warnings).toEqual([
      'edit channel: there is no channel "Theremin"',
      'add effect: there is no mixer track 99',
      'add effect: "3xOsc" is an instrument, not an effect',
      'sidechain: there is no effect "fx_none"',
      "remove insert: the Master track can't be deleted",
    ]);
    expect(res.changes).toEqual(['Song: tempo 99 BPM']);
  });

  it('refuses routing loops', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'route', from: '1', to: '2' },
      { op: 'route', from: '2', to: '1' },
    ]);
    expect(res.warnings).toEqual(["route: Insert 2 can't route to Insert 1 (it would loop back)"]);
  });

  it('writes notes, places patterns and plays', () => {
    const s = createTestServices();
    const kick = s.doc.getState().project.channelOrder[0] as ChannelId;
    const res = run(s, [
      { op: 'add_pattern', ref: '@verse', name: 'Verse', bars: 2 },
      {
        op: 'write_notes',
        pattern: '@verse',
        channel: kick,
        notes: [{ step: 0 }, { step: 4, vel: 100 }, { step: 8 }, { step: 12 }],
      },
      { op: 'place_pattern', pattern: '@verse', bar: 3, times: 2 },
      { op: 'transport', action: 'play', mode: 'song', from_bar: 3 },
    ]);
    const project = s.doc.getState().project;
    const verse = Object.values(project.patterns).find((x) => x.name === 'Verse')!;
    const notes = Object.values(verse.notes[kick] ?? {}).sort((x, y) => x.tick - y.tick);
    expect(notes.map((n) => n.tick)).toEqual([0, 960, 1920, 2880]);
    expect(notes[1]!.velocity).toBeCloseTo(100 / 127);
    const clips = Object.values(project.playlist.clips).filter((c) => c.kind === 'pattern' && c.patternId === verse.id);
    expect(clips.map((c) => c.start).sort((x, y) => x - y)).toEqual([7680, 7680 + 7680]);
    expect(res.after).toContainEqual({ kind: 'play', fromTick: 7680, mode: 'song' });
    expect(s.view.getState().currentPatternId).toBe(verse.id);
  });

  it('writes beats like the beat assistant and changes them on follow-ups', () => {
    const s = createTestServices();
    const beat = (hat: number[]) => ({
      op: 'beat',
      title: 'Test beat',
      bars: 1,
      tracks: [
        { name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 8 }] },
        { name: 'Hat', sound: 'hat', notes: hat.map((step) => ({ step })) },
      ],
    });
    const first = run(s, [beat([0, 4, 8, 12])]);
    expect(first.beat).not.toBeNull();
    const again = applyAnswer(
      s,
      { message: 'busier', actions: [beat([0, 2, 4, 6, 8, 10, 12, 14])] },
      { previousBeat: first.beat },
    );
    expect(again.beat!.patternId).toBe(first.beat!.patternId);
    const p = s.doc.getState().project;
    expect(Object.keys(p.patterns[again.beat!.patternId]!.notes[again.beat!.channels.hat!] ?? {})).toHaveLength(8);
  });

  it('finds mixer tracks by number, name and id', () => {
    const s = createTestServices();
    const ins = s.doc.getState().project.mixer.order[3] as InsertId;
    run(s, [
      { op: 'edit_insert', insert: '3', name: 'Drums' },
      { op: 'edit_insert', insert: 'drums', pan: 0.5 },
      { op: 'edit_insert', insert: ins, mute: true },
    ]);
    expect(s.doc.getState().project.mixer.inserts[ins]).toMatchObject({ name: 'Drums', pan: 0.5, muted: true });
  });
});

describe('AI actions on notes and steps', () => {
  const pat = (s: ReturnType<typeof createTestServices>) => s.doc.getState().project.patternOrder[0]!;
  const instrument = (s: ReturnType<typeof createTestServices>) => {
    const p = s.doc.getState().project;
    return p.channelOrder.find((id) => p.channels[id]?.kind === 'instrument')!;
  };

  it('runs a piano-roll tool on notes written earlier in the same answer', () => {
    const s = createTestServices();
    const ch = instrument(s);
    const res = run(s, [
      {
        op: 'write_notes',
        pattern: pat(s),
        channel: ch,
        notes: [
          { step: 0, len: 2, key: 60 },
          { step: 4, len: 2, key: 64 },
        ],
      },
      {
        op: 'note_tool',
        tool: 'agstudio.notes.transpose',
        pattern: pat(s),
        channel: ch,
        params: [{ name: 'semitones', value: 12 }],
      },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.changes.at(-1)).toMatch(/^Transpose on/);
    const notes = Object.values(s.doc.getState().project.patterns[pat(s)]!.notes[ch]!);
    expect(notes.map((n) => n.key).sort()).toEqual([72, 76]);
    // One undo step for the whole answer.
    s.history.undo();
    expect(s.doc.getState().project.patterns[pat(s)]!.notes[ch]).toBeUndefined();
  });

  it('warns about an unknown tool and keeps the rest of the answer', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'song', bpm: 99 },
      { op: 'note_tool', tool: 'agstudio.notes.teleport', pattern: 'current', channel: instrument(s) },
    ]);
    expect(res.warnings).toEqual([expect.stringContaining('there is no piano-roll tool')]);
    expect(s.doc.getState().project.transport.bpm).toBe(99);
  });

  it('fills, rotates and clears a channel’s steps', () => {
    const s = createTestServices();
    const ch = instrument(s);
    const ticks = () =>
      Object.values(s.doc.getState().project.patterns[pat(s)]!.notes[ch] ?? {})
        .map((n) => n.tick)
        .sort((a, b) => a - b);
    run(s, [{ op: 'steps', pattern: pat(s), channel: ch, action: 'clear' }]);
    run(s, [{ op: 'steps', pattern: pat(s), channel: ch, action: 'fill', every: 4 }]);
    expect(ticks()).toEqual([0, 960, 1920, 2880]);
    run(s, [{ op: 'steps', pattern: pat(s), channel: ch, action: 'rotate', by: 2 }]);
    expect(ticks()).toEqual([480, 1440, 2400, 3360]);
    const res = run(s, [{ op: 'steps', pattern: pat(s), channel: ch, action: 'clear' }]);
    expect(res.changes).toEqual([expect.stringMatching(/^Cleared the steps of/)]);
    expect(ticks()).toEqual([]);
  });
});

describe('AI automation', () => {
  const automations = (s: ReturnType<typeof createTestServices>) =>
    Object.values(s.doc.getState().project.channels).filter((c) => c.kind === 'automation');

  it('fades a channel in over four bars, in dB, as one clip on the playlist', () => {
    const s = createTestServices();
    const p0 = s.doc.getState().project;
    const ch = p0.channelOrder.find((id) => p0.channels[id]?.kind === 'instrument')!;
    const res = run(s, [
      {
        op: 'automate',
        target: { kind: 'channel_volume', channel: ch },
        from_bar: 3,
        bars: 4,
        points: [
          { bar: 0, value: -60, tension: -0.5 },
          { bar: 4, value: -6 },
        ],
      },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.changes[0]).toMatch(/^Automation “.+”, bars 3–7: /);
    const [auto] = automations(s);
    expect(auto?.kind === 'automation' && auto.target).toEqual({ kind: 'channel', channelId: ch, param: 'volume' });
    if (auto?.kind !== 'automation') return;
    const p = s.doc.getState().project;
    const resolved = resolveTarget(p, auto.target!, (id) => s.plugins.get(id)?.params as never)!;
    expect(resolved.fromNormalized(auto.points[1]!.value)).toBeCloseTo(10 ** (-6 / 20), 3);
    expect(auto.points[0]).toMatchObject({ tick: 0, tension: -0.5 });
    const clip = Object.values(p.playlist.clips).find((c) => c.kind === 'automation')!;
    expect(clip).toMatchObject({ start: 2 * 3840, length: 4 * 3840 });
  });

  it('wobbles a synth setting with an LFO and ramps the tempo past 180 BPM', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'add_channel', ref: '@lead', plugin: 'agstudio.3xosc', name: 'Lead' },
      {
        op: 'automate',
        target: { kind: 'plugin', channel: '@lead', param: 'cutoff' },
        bars: 2,
        lfo: { shape: 'sine', beats: 0.5, depth: 0.6 },
      },
      {
        op: 'automate',
        target: { kind: 'tempo' },
        bars: 8,
        points: [
          { bar: 0, value: 140 },
          { bar: 8, value: 200 },
        ],
      },
    ]);
    expect(res.warnings).toEqual([]);
    const [wobble, tempo] = automations(s);
    expect(wobble?.kind === 'automation' && wobble.points.length).toBeGreaterThan(8);
    if (tempo?.kind !== 'automation') throw new Error('no tempo automation');
    expect(tempo.target).toEqual({ kind: 'tempo' });
    // The range grows to fit 200 BPM; the points still read back as BPM.
    expect(tempo.range!.max).toBeGreaterThanOrEqual(200);
    const p = s.doc.getState().project;
    const r = resolveTarget(p, tempo.target!, () => undefined, tempo.range)!;
    expect(r.fromNormalized(tempo.points[0]!.value)).toBeCloseTo(140, 6);
    expect(r.fromNormalized(tempo.points[1]!.value)).toBeCloseTo(200, 6);
  });

  it('warns about a control it cannot find and applies the rest', () => {
    const s = createTestServices();
    const res = run(s, [
      { op: 'song', bpm: 101 },
      { op: 'automate', target: { kind: 'plugin', channel: 'nobody', param: 'cutoff' }, points: [{ bar: 0, value: 1 }] },
    ]);
    expect(res.warnings).toEqual([expect.stringContaining('there is no channel')]);
    expect(s.doc.getState().project.transport.bpm).toBe(101);
  });
});

describe('answer parsing and value coercion', () => {
  it('reads answers and drops unknown actions', () => {
    const r = readAnswer({ message: 'hi', actions: [{ op: 'song', bpm: 1 }, { op: 'launch_rockets' }, 'x'] });
    expect(r).toEqual({ answer: { message: 'hi', actions: [{ op: 'song', bpm: 1 }] }, dropped: 2 });
    expect(readAnswer({ actions: [] })).toEqual({ error: 'the answer has no message' });
  });

  it('coerces values to each spec', () => {
    expect(coerceParam(p.float(0, 1, 0.5, { unit: '%' }), 75)).toBe(0.75);
    expect(coerceParam(p.float(20, 20000, 1000), '2500 Hz')).toBe(2500);
    expect(coerceParam(p.int(-24, 24, 0), 3.6)).toBe(4);
    expect(coerceParam(p.enum(['sine', 'square'], 'sine'), 'SQUARE')).toBe('square');
    expect(coerceParam(p.enum(['sine', 'square'], 'sine'), 'saw')).toBeNull();
    expect(coerceParam(p.bool(false), 'on')).toBe(true);
    expect(parseKey('F# dorian')).toEqual({ root: 6, scale: 'dorian' });
    expect(parseKey('Bb minor')).toEqual({ root: 10, scale: 'minor' });
    expect(parseKey('none')).toBeNull();
    // Scale names map to the SDK's scale ids (what the piano roll highlights).
    expect(parseKey('Am')).toEqual({ root: 9, scale: 'minor' });
    expect(parseKey('E pentatonic minor')).toEqual({ root: 4, scale: 'minor-pentatonic' });
    expect(parseKey('C lydian mode')).toEqual({ root: 0, scale: 'lydian' });
    expect(parseKey('G harmonic minor')).toEqual({ root: 7, scale: 'harmonic-minor' });
    expect(parseKey('F# sparkly')).toBeUndefined();
  });

  it('has a schema structured outputs accept (no numeric bounds, closed objects)', () => {
    const walk = (node: unknown, path: string): void => {
      if (typeof node !== 'object' || node === null) return;
      const o = node as Record<string, unknown>;
      for (const bad of ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength'])
        expect(o[bad], `${path}.${bad}`).toBeUndefined();
      if (o.type === 'object') expect(o.additionalProperties, path).toBe(false);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(ACTIONS_SCHEMA, 'schema');
  });
});
