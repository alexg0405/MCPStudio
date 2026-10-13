import { describe, expect, it } from 'vitest';
import { MASTER, type ChannelId, type InsertId } from '@core/model/types';
import { createTestServices } from '../testing';
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
