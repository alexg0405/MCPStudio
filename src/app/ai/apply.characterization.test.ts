/**
 * Characterization of the AI action applier: one answer runs every op (including ones that fail) on
 * seeded ids, and the changes, warnings, after-edits and resulting project are pinned. It guards
 * refactors of the op modules: any change in behaviour shows up here first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MASTER, type ChannelId, type ClipId, type SampleId } from '@core/model/types';
import { seededBytes, setIdSource, type RandomBytes } from '@core/model/ids';
import { createTestServices } from '../testing';
import { applyAnswer } from './apply';
import { ACTION_OPS, type AiAction } from './schema';
import { STUDIO_PROMPT } from './prompt';

/** FNV-1a, 32-bit, as hex. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const ACTIONS: AiAction[] = [
  { op: 'song', bpm: 142, swing: 12, key: 'F minor', time_signature: '4/4' },
  { op: 'song', key: 'H major', time_signature: '5/3' },
  {
    op: 'add_channel',
    ref: '@lead',
    plugin: 'agstudio.3xosc',
    name: 'Lead',
    params: [
      { name: 'cutoff', value: 1200 },
      { name: 'nope', value: 1 },
      { name: 'osc1Wave', value: 'not-a-wave' },
    ],
    volume_db: -6,
    pan: 0.25,
    color: '#336699',
  },
  { op: 'add_channel', ref: '@perc', plugin: 'agstudio.sampler', name: 'Rim', sample: 'rim' },
  { op: 'add_channel', plugin: 'agstudio.sampler', name: 'Mystery' },
  { op: 'add_channel', plugin: 'agstudio.nothing' },
  { op: 'add_channel', plugin: 'agstudio.reverb' },
  { op: 'edit_channel', channel: '@lead', name: 'Lead 2', volume_db: -4, pan: -0.5, mute: true, solo: false },
  { op: 'edit_channel', channel: 'Lead 2', pitch_cents: 3000, preset: 'No such preset', mute: false },
  { op: 'edit_channel', channel: 'Lead 2', reverse: true },
  { op: 'edit_channel', channel: 'nobody', volume_db: 0 },
  { op: 'add_insert', ref: '@bus', name: 'Lead bus', volume_db: -3, pan: 0.1, color: '#aa5500' },
  { op: 'add_insert', ref: '@verbBus', name: 'Reverb' },
  { op: 'edit_channel', channel: '@lead', insert: '@bus' },
  { op: 'edit_insert', insert: '@bus', name: 'Leads', mute: true, solo: true },
  { op: 'edit_insert', insert: '@bus', mute: false, solo: false },
  { op: 'edit_insert', insert: '99', name: 'Nope' },
  { op: 'add_effect', ref: '@verb', insert: '@verbBus', plugin: 'agstudio.reverb', preset: 'Hall', mix: 1 },
  { op: 'add_effect', ref: '@eq', insert: '@bus', plugin: 'agstudio.eq', params: [{ name: 'nope', value: 1 }] },
  { op: 'add_effect', insert: '@bus', plugin: 'agstudio.3xosc' },
  { op: 'edit_effect', effect: '@eq', mix: 50, enabled: false, position: 1 },
  { op: 'edit_effect', effect: '@eq', enabled: true },
  { op: 'route', from: '@bus', to: '@verbBus', level_db: -8, pre: true },
  { op: 'route', from: '@verbBus', to: '@bus' },
  { op: 'unroute', from: '@bus', to: '@verbBus' },
  { op: 'route_only', from: '@bus', to: 'master' },
  { op: 'add_effect', ref: '@duck', insert: '@bus', plugin: 'agstudio.ducker' },
  { op: 'sidechain', effect: '@duck', from: '1' },
  { op: 'sidechain', effect: '@verb', from: '1' },
  { op: 'sidechain', effect: '@duck', from: 'none' },
  { op: 'remove_effect', effect: '@eq' },
  { op: 'remove_insert', insert: 'master' },
  { op: 'add_pattern', ref: '@verse', name: 'Verse', bars: 2 },
  { op: 'add_pattern', ref: '@tmp', name: 'Temp' },
  { op: 'edit_pattern', pattern: '@verse', name: 'Verse A', color: '#228844', bars: 2 },
  { op: 'remove_pattern', pattern: '@tmp' },
  { op: 'remove_pattern', pattern: 'nothing' },
  {
    op: 'write_notes',
    pattern: '@verse',
    channel: '@lead',
    notes: [
      { step: 0, len: 2, key: 60, vel: 0.9 },
      { step: 4, len: 2, key: 63, vel: 100 },
      { step: 8.5, key: 67 },
      { step: -1, key: 60 },
      { step: 40, len: 4, key: 70 },
    ],
  },
  { op: 'write_notes', pattern: '@verse', channel: '@perc', notes: [{ step: 2 }, { step: 6, vel: 0.4 }] },
  { op: 'write_notes', pattern: '@verse', channel: '@perc', replace: false, notes: [{ step: 10 }] },
  { op: 'note_tool', tool: 'agstudio.notes.transpose', pattern: '@verse', channel: '@lead', params: [{ name: 'semitones', value: 2 }] },
  { op: 'note_tool', tool: 'agstudio.notes.transpose', pattern: '@verse', channel: '@lead', params: [{ name: 'semitones', value: 'x' }] },
  { op: 'note_tool', tool: 'agstudio.notes.teleport', pattern: '@verse', channel: '@lead' },
  { op: 'steps', pattern: '@verse', channel: '@perc', action: 'fill', every: 4 },
  { op: 'steps', pattern: '@verse', channel: '@perc', action: 'rotate', by: 2 },
  { op: 'steps', pattern: '@verse', channel: '@perc', action: 'shift', by: -1 },
  { op: 'steps', pattern: '@verse', channel: '@perc', action: 'reverse' },
  { op: 'steps', pattern: '@verse', channel: '@perc', action: 'randomize', density: 0.5 },
  { op: 'steps', pattern: '@verse', channel: '@perc', action: 'wiggle' },
  { op: 'clear_notes', pattern: '@verse', channel: '@perc' },
  { op: 'write_notes', pattern: '@verse', channel: '@perc', notes: [{ step: 0 }, { step: 8 }] },
  {
    op: 'automate',
    ref: '@sweep',
    target: { kind: 'plugin', channel: '@lead', param: 'cutoff' },
    from_bar: 2,
    bars: 4,
    points: [
      { bar: 0, value: 400 },
      { bar: 2, value: 4000, shape: 'smooth', tension: 0.3 },
      { bar: 4, value: 'loud' },
    ],
  },
  { op: 'automate', target: { kind: 'track_volume', insert: '@bus' }, bars: 2, lfo: { shape: 'sine', beats: 1, depth: 0.5 } },
  { op: 'automate', target: { kind: 'tempo' }, from_bar: 5, bars: 4, points: [{ bar: 0, value: 142 }, { bar: 4, value: 200 }] },
  { op: 'automate', target: { kind: 'send', insert: '@bus', to: '@verbBus' }, points: [{ bar: 0, value: -12 }] },
  { op: 'automate', target: { kind: 'plugin', channel: 'nobody', param: 'cutoff' }, points: [{ bar: 0, value: 1 }] },
  { op: 'automate', target: { kind: 'wobble' }, points: [{ bar: 0, value: 1 }] },
  { op: 'place_pattern', pattern: '@verse', bar: 3, times: 2 },
  { op: 'place_pattern', pattern: '@verse', bar: 1, track: 2, bars: 1 },
  { op: 'place_pattern', pattern: 'Verse A', bar: 9, track: 40 },
  { op: 'edit_audio_clip', clip: 'clip_loop', gain_db: -6, fade_in: 0.01, fade_out: 0.5 },
  { op: 'edit_audio_clip', clip: 'clip_none', gain_db: 0 },
  { op: 'marker', action: 'add', name: 'Verse', bar: 3 },
  { op: 'marker', action: 'add', name: 'Drop', bar: 9, color: '#e5574d' },
  { op: 'marker', action: 'edit', marker: 'drop', name: 'Big drop', bar: 11 },
  { op: 'marker', action: 'remove', marker: 'Verse' },
  { op: 'marker', action: 'remove', marker: 'Bridge' },
  { op: 'marker', action: 'jump' },
  { op: 'clear_playlist', from_bar: 1, to_bar: 1, track: 2 },
  {
    op: 'beat',
    title: 'Test beat',
    bars: 1,
    tracks: [
      { name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 8 }] },
      { name: 'Hat', sound: 'hat', notes: [0, 2, 4, 6, 8, 10, 12, 14].map((step) => ({ step, vel: step % 4 ? 0.5 : 0.9 })) },
      { name: '808', sound: '808', notes: [{ step: 0, len: 6, key: 29 }, { step: 8, len: 6, key: 32 }] },
    ],
  },
  { op: 'beat', title: 'Broken', bars: 1, tracks: [] },
  { op: 'remove_channel', channel: 'Rim' },
  { op: 'remove_channel', channel: 'Rim' },
  {
    op: 'arrange',
    from_bar: 13,
    style: 'trap',
    mix: 'keep',
    sections: [
      { name: 'Intro', bars: 2, play: ['Verse A'], without: ['Lead 2'] },
      { name: 'Drop', role: 'drop', bars: 4, energy: 5, play: ['Test beat'] },
    ],
  },
  { op: 'arrange', sections: [{ name: 'Nowhere', bars: 2, play: ['nothing'] }] },
  { op: 'develop', from_bar: 1, to_bar: 8, fx: false },
  { op: 'transition', bar: 15, kind: 'gap', beats: 1 },
  { op: 'transition', bar: 15, kind: 'sparkle' },
  { op: 'vary', kind: 'hat_roll', bar: 16 },
  { op: 'vary', kind: 'fill', pattern: 'Test beat', ref: '@fill' },
  { op: 'vary', kind: 'nope', bar: 1 },
  { op: 'transport', action: 'play', mode: 'song', from_bar: 3, metronome: true },
  { op: 'transport', mode: 'pattern' },
  { op: 'audition', channel: 'Lead 2', phrase: 'riff' },
  { op: 'audition', channel: 'nobody' },
  { op: 'analyze_mix' },
  { op: 'analyze_mix' },
  { op: 'build_plugin', name: 'Tape Stop', kind: 'effect', description: 'Slows to a halt.' },
  { op: 'build_plugin', name: 'Nameless' },
  { op: 'command', id: 'file.save' },
  { op: 'command', id: 'no.such.command' },
  { op: 'open', window: 'mixer' },
  { op: 'open', window: 'plugin', effect: '@verb' },
  { op: 'open', window: 'piano-roll', channel: 'Lead 2' },
  { op: 'open', window: 'garage' },
];

describe('AI applier characterization', () => {
  let prevSource: RandomBytes;
  beforeEach(() => {
    prevSource = setIdSource(seededBytes(1));
    let seed = 0.123;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (seed * 9301 + 0.49297) % 1;
      return seed;
    });
  });
  afterEach(() => {
    setIdSource(prevSource);
    vi.restoreAllMocks();
  });

  it('applies every op the same way', () => {
    const s = createTestServices();
    // An audio clip for edit_audio_clip to find.
    s.history.transact('setup', (d) => {
      const sampleId = 'smp_loop' as SampleId;
      const channelId = 'ch_loop' as ChannelId;
      d.samples[sampleId] = { id: sampleId, name: 'Loop', source: { kind: 'builtin', generator: 'kit/kick' } } as never;
      d.channels[channelId] = {
        kind: 'audioClip',
        id: channelId,
        name: 'Loop',
        color: '#888888',
        muted: false,
        solo: false,
        volume: 0.8,
        pan: 0,
        output: MASTER,
        sampleId,
      };
      d.channelOrder.push(channelId);
      d.playlist.clips['clip_loop' as ClipId] = {
        kind: 'audio',
        id: 'clip_loop' as ClipId,
        laneId: d.playlist.laneOrder[5]!,
        start: 0,
        length: 3840,
        channelId,
        offsetSec: 0,
      };
    });
    const res = applyAnswer(s, { message: 'Everything at once.', actions: ACTIONS }, { previousBeat: null, label: 'everything' });
    const { meta: _meta, ...project } = s.doc.getState().project;
    expect({
      edited: res.edited,
      undo: s.history.steps().done.map((e) => e.label),
      beat: res.beat ? { channels: Object.keys(res.beat.channels).sort(), created: res.beat.created.length } : null,
      currentPattern: s.view.getState().currentPatternId,
      selectedChannel: s.session.getState().selectedChannelId,
    }).toMatchSnapshot();
    expect(res.changes).toMatchSnapshot();
    expect(res.warnings).toMatchSnapshot();
    expect(res.after).toMatchSnapshot();
    expect(hash(JSON.stringify(project))).toMatchSnapshot();
  });

  it('keeps the op list and the prompt', () => {
    expect(ACTION_OPS.map((o) => o.properties.op.const)).toMatchSnapshot();
    expect(hash(JSON.stringify(ACTION_OPS))).toMatchSnapshot();
    expect(hash(STUDIO_PROMPT)).toMatchSnapshot();
  });
});
