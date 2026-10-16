import { describe, expect, it } from 'vitest';
import type { AutomationChannel } from '@core/model/types';
import { project, stackedSong } from '../../../test/helpers/focus';
import { applyAnswer } from './apply';
import { readTools, runReadTool } from './read';
import type { AiAction } from './schema';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const read = (s: ReturnType<typeof stackedSong>['s'], name: string, args: Record<string, unknown> = {}) =>
  runReadTool(s, name, args) as J;
const act = (s: ReturnType<typeof stackedSong>['s'], actions: AiAction[]) =>
  applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });

describe('the read tools as a set', () => {
  it('have unique names, descriptions and closed schemas', () => {
    const names = readTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ['get_pattern_notes', 'get_mixer', 'get_channel', 'get_clips', 'get_automation', 'get_selection', 'get_transport'])
      expect(names).toContain(n);
    for (const t of readTools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.schema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('every tool runs on the song with no arguments, returns plain JSON and never throws on junk arguments', () => {
    const { s } = stackedSong();
    for (const t of readTools) {
      const out = t.run(s, {});
      expect(JSON.parse(JSON.stringify(out))).toEqual(out);
      for (const junk of [{ pattern: 'nope' }, { channel: 7 }, { insert: {} }, { from_bar: 'x', to_bar: -3 }, { target: 5 }, { tracks: 'a' }, { kind: 3 }, { plugin: [] }])
        expect(() => t.run(s, junk)).not.toThrow();
    }
  });

  it('an unknown tool is an error that lists the tools', () => {
    const { s } = stackedSong();
    const r = read(s, 'get_everything');
    expect(r.error).toContain('get_mixer');
  });
});

describe('get_project and get_transport', () => {
  it('gives the overview with ids and names', () => {
    const { s } = stackedSong();
    const r = read(s, 'get_project');
    expect(r.bpm).toBe(150);
    expect(r.time_signature).toBe('4/4');
    expect(r.length_bars).toBe(112);
    expect(r.channels.find((c: J) => c.name === 'Kick')).toMatchObject({ kind: 'instrument', plugin: 'agstudio.sampler' });
    expect(r.channels.every((c: J) => c.kind !== 'automation')).toBe(true);
    expect(r.automation_channels).toBeGreaterThan(0);
    expect(r.patterns.map((x: J) => x.name)).toContain('Drop');
    expect(r.mixer[0]).toMatchObject({ n: 0, id: 'master', name: 'Master' });
    expect(r.tracks.length).toBe(18);
  });

  it('reads the transport and follows the actions', () => {
    const { s } = stackedSong();
    expect(read(s, 'get_transport')).toMatchObject({ bpm: 150, mode: 'pattern', playing: false, loop: null });
    act(s, [
      { op: 'song', bpm: 96, time_signature: '3/4' },
      { op: 'select', loop: { from_bar: 5, to_bar: 8 } },
      { op: 'settings', metronome: true, count_in_bars: 2 },
    ]);
    expect(read(s, 'get_transport')).toMatchObject({
      bpm: 96,
      time_signature: '3/4',
      loop: { from_bar: 5, to_bar: 8 },
      metronome: true,
      count_in_bars: 2,
    });
  });
});

describe('get_pattern_notes', () => {
  it('lists a channel’s notes in the units write_notes takes', () => {
    const { s } = stackedSong();
    const r = read(s, 'get_pattern_notes', { pattern: 'Drop', channel: 'Kick' });
    expect(r.pattern.name).toBe('Drop');
    expect(r.columns).toEqual(['step', 'len', 'key', 'vel']);
    expect(r.channels).toHaveLength(1);
    expect(r.channels[0].count).toBe(7);
    expect(r.channels[0].notes.slice(0, 3)).toEqual([
      [0, 1, 60, 0.9],
      [10, 1, 60, 0.9],
      [14, 1, 60, 0.9],
    ]);
  });

  it('keeps to a bar range, covers all channels without one, and can round-trip through write_notes', () => {
    const { s } = stackedSong();
    const second = read(s, 'get_pattern_notes', { pattern: 'Drop', channel: '808', from_bar: 2, to_bar: 2 });
    expect(second.channels[0].notes.every((n: number[]) => n[0]! >= 16)).toBe(true);
    const all = read(s, 'get_pattern_notes', { pattern: 'Drop' });
    expect(all.channels.map((c: J) => c.name)).toContain('Kick');
    const bass = all.channels.find((c: J) => c.name === '808');
    act(s, [
      { op: 'add_pattern', ref: '@copy', name: 'Round trip' },
      { op: 'write_notes', pattern: '@copy', channel: '808', notes: bass.notes.map((n: number[]) => ({ step: n[0], len: n[1], key: n[2], vel: n[3] })) },
    ]);
    const back = read(s, 'get_pattern_notes', { pattern: 'Round trip', channel: '808' });
    expect(back.channels[0].notes).toEqual(bass.notes);
  });

  it('truncates at the limit and says so; unknown things are errors', () => {
    const { s } = stackedSong();
    const r = read(s, 'get_pattern_notes', { pattern: 'Drop', limit: 4 });
    expect(r.truncated).toBe(true);
    expect(r.channels.reduce((n: number, c: J) => n + c.notes.length, 0)).toBe(4);
    expect(read(s, 'get_pattern_notes', { pattern: 'No such' }).error).toContain('no pattern');
    expect(read(s, 'get_pattern_notes', { channel: 'No such' }).error).toContain('no channel');
  });
});

describe('get_channel', () => {
  it('lists the channels, and gives one with every setting, its unit, range and the volume in dB', () => {
    const { s } = stackedSong();
    const list = read(s, 'get_channel');
    expect(list.channels.map((c: J) => c.name)).toContain('Pluck');
    const r = read(s, 'get_channel', { channel: 'Pluck' });
    expect(r).toMatchObject({ name: 'Pluck', kind: 'instrument', plugin: 'agstudio.pluck' });
    expect(typeof r.volume_db).toBe('number');
    expect(r.insert).toMatchObject({ n: expect.any(Number) });
    const first = r.params[0];
    expect(first).toMatchObject({ id: expect.any(String), type: expect.any(String), value: expect.anything(), text: expect.any(String) });
    expect(r.params.some((x: J) => x.type === 'float' && typeof x.min === 'number' && typeof x.max === 'number')).toBe(true);
  });

  it('shows a loaded preset by name, and "edited" after a knob moved', () => {
    const { s } = stackedSong();
    act(s, [{ op: 'edit_channel', channel: 'Pluck', preset: 'Harp' }]);
    expect(read(s, 'get_channel', { channel: 'Pluck' }).preset).toEqual({ name: 'Harp', edited: false });
    const id = read(s, 'get_channel', { channel: 'Pluck' }).params.find((x: J) => x.type === 'float').id as string;
    const spec = read(s, 'get_plugins', { plugin: 'agstudio.pluck' }).params.find((x: J) => x.id === id);
    act(s, [{ op: 'edit_channel', channel: 'Pluck', params: [{ name: id, value: spec.value === spec.max ? spec.min : spec.max }] }]);
    expect(read(s, 'get_channel', { channel: 'Pluck' }).preset).not.toEqual({ name: 'Harp', edited: false });
  });

  it('reads a missing channel and an automation channel', () => {
    const { s } = stackedSong();
    expect(read(s, 'get_channel', { channel: 'Nope' }).error).toContain('no channel');
    const auto = Object.values(project(s).channels).find((c) => c.kind === 'automation') as AutomationChannel;
    expect(read(s, 'get_channel', { channel: auto.id })).toMatchObject({ kind: 'automation', points: auto.points.length });
  });
});

describe('get_mixer', () => {
  it('shows routes, effects with their settings and presets, sidechains, and counts the unused tracks', () => {
    const { s } = stackedSong();
    const r = read(s, 'get_mixer');
    const master = r.inserts[0];
    expect(master).toMatchObject({ n: 0, id: 'master', name: 'Master' });
    expect(master.fx.map((f: J) => f.plugin)).toContain('agstudio.limiter');
    expect(master.fx.find((f: J) => f.plugin === 'agstudio.limiter').preset).toMatchObject({ edited: false });
    expect(r.unused_tracks.length).toBeGreaterThan(0);
    expect(r.inserts.length + r.unused_tracks.length).toBe(project(s).mixer.order.length);
  });

  it('shows a sidechain, a send and a changed setting in dB / its unit', () => {
    const { s } = stackedSong();
    act(s, [
      { op: 'add_insert', ref: '@bus', name: 'Pump bus', volume_db: -6 },
      { op: 'add_effect', ref: '@duck', insert: '@bus', plugin: 'agstudio.ducker' },
      { op: 'sidechain', effect: '@duck', from: '1' },
      { op: 'route', from: '@bus', to: '2', level_db: -3, pre: true },
    ]);
    const n = project(s).mixer.order.length - 1;
    const bus = read(s, 'get_mixer', { insert: String(n) }).inserts[0];
    expect(bus).toMatchObject({ name: 'Pump bus', volume_db: -6 });
    expect(bus.routes).toContainEqual({ to: 0, name: 'Master', level_db: 0, pre: false });
    expect(bus.routes).toContainEqual({ to: 2, name: 'Insert 2', level_db: -3, pre: true });
    expect(bus.fx[0]).toMatchObject({ plugin: 'agstudio.ducker', sidechain_from: { n: 1 } });
    const all = read(s, 'get_mixer', { insert: String(n), all_params: true }).inserts[0].fx[0].params;
    expect(all.length).toBeGreaterThan(bus.fx[0].params.length);
    expect(all[0]).toHaveProperty('default');
    expect(read(s, 'get_mixer', { insert: 'Nowhere' }).error).toContain('no mixer track');
  });
});

describe('get_clips', () => {
  it('filters by bars, track and kind and names what plays', () => {
    const { s } = stackedSong();
    const r = read(s, 'get_clips', { from_bar: 37, to_bar: 38, tracks: [1] });
    expect(r.clips).toEqual([expect.objectContaining({ track: 1, bar: 37, bars: 2, kind: 'pattern', name: 'Drop' })]);
    expect(r.tracks).toEqual([expect.objectContaining({ n: 1 })]);
    const autos = read(s, 'get_clips', { kind: 'automation' });
    expect(autos.clips.length).toBeGreaterThan(0);
    expect(autos.clips.every((c: J) => c.kind === 'automation')).toBe(true);
  });

  it('truncates and reports the total', () => {
    const { s } = stackedSong();
    const r = read(s, 'get_clips', { limit: 5 });
    expect(r.clips).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect(r.total).toBeGreaterThan(5);
  });
});

describe('get_automation', () => {
  it('lists the automation channels with their clips, and one curve in the control’s own unit', () => {
    const { s } = stackedSong();
    const list = read(s, 'get_automation');
    expect(list.automation.length).toBeGreaterThan(5);
    expect(list.automation[0].clips[0]).toMatchObject({ track: expect.any(Number), bar: expect.any(Number), bars: expect.any(Number) });
    const master = list.automation.find((x: J) => x.drives === 'Volume · Master');
    const one = read(s, 'get_automation', { channel: master.id }).automation[0];
    expect(one.curve).toHaveLength(2);
    expect(typeof one.curve[0].value).toBe('number');
    expect(one.curve[0].text).toMatch(/dB/);
  });

  it('finds the curves of a control by its target, including one drawn just now', () => {
    const { s } = stackedSong();
    act(s, [
      {
        op: 'automate',
        target: { kind: 'tempo' },
        from_bar: 1,
        bars: 4,
        points: [
          { bar: 0, value: 120 },
          { bar: 4, value: 90 },
        ],
      },
    ]);
    const r = read(s, 'get_automation', { target: { kind: 'tempo' } }).automation;
    expect(r).toHaveLength(1);
    expect(r[0].curve.map((p: J) => p.value)).toEqual([120, 90]);
    expect(read(s, 'get_automation', { target: { kind: 'nonsense' } }).error).toContain('automate');
  });
});

describe('get_selection, get_settings, get_windows', () => {
  it('reports what select picked', () => {
    const { s } = stackedSong();
    act(s, [
      { op: 'select', channel: 'Kick', pattern: 'Drop', notes: { from_bar: 1, to_bar: 1 }, clips: { track: 1, from_bar: 37, to_bar: 40 } },
    ]);
    const r = read(s, 'get_selection');
    expect(r.channel.name).toBe('Kick');
    expect(r.pattern.name).toBe('Drop');
    expect(r.notes).toMatchObject({ count: 3, lowest_key: 60, highest_key: 60 });
    expect(r.clips.count).toBe(2);
    expect(r.clips).toMatchObject({ from_bar: 37, to_bar: 40 });
  });

  it('reports the settings the settings action changed', () => {
    const { s } = stackedSong();
    act(s, [
      { op: 'settings', follow_playhead: false, record_mode: 'replace', record_quantize: '1/8', audio_buffer: 'medium', export: { codec: 'mp3', mp3_kbps: 192 }, piano_roll: { tool: 'slice', snap: 'beat' } },
    ]);
    expect(read(s, 'get_settings')).toMatchObject({
      follow_playhead: false,
      record_mode: 'replace',
      record_quantize: '1/8',
      audio_buffer: 'medium',
      export: { codec: 'mp3', mp3_kbps: 192 },
      piano_roll: { tool: 'slice', snap: 'beat' },
    });
  });

  it('lists the open windows', () => {
    const { s } = stackedSong();
    s.view.getState().showWindow('mixer', 'mixer');
    s.view.getState().showWindow('playlist', 'playlist');
    const r = read(s, 'get_windows');
    expect(r.windows.map((w: J) => w.id)).toEqual(['playlist', 'mixer']);
    expect(r.windows[0].focused).toBe(true);
    expect(r.available).toContain('piano-roll');
  });
});

describe('get_plugins', () => {
  it('lists by kind, and gives a plugin’s settings with unit, range and options', () => {
    const { s } = stackedSong();
    const fx = read(s, 'get_plugins', { kind: 'effect' }).plugins;
    expect(fx.every((p: J) => p.kind === 'effect')).toBe(true);
    expect(fx.map((p: J) => p.id)).toContain('agstudio.reverb');
    const tools = read(s, 'get_plugins', { kind: 'tool' }).plugins;
    expect(tools.length).toBeGreaterThan(0);
    const rv = read(s, 'get_plugins', { plugin: 'Reverb' });
    expect(rv.id).toBe('agstudio.reverb');
    expect(rv.params.find((p: J) => p.id === 'decay')).toMatchObject({ unit: 's', min: 0.2, max: 10 });
    expect(rv.params.find((p: J) => p.id === 'engine').options).toEqual(['algorithmic', 'convolution']);
    expect(rv.presets.map((p: J) => p.name)).toContain('Plate');
    expect(read(s, 'get_plugins', { plugin: 'nope' }).error).toContain('no plugin');
  });
});
