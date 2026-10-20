/**
 * The actions that make Studio able to drive everything: settings, selection, windows, presets, and the
 * additions to song, edit_channel, edit_insert and the pattern actions (copy, split, move, sample swap).
 * Each: valid, invalid arguments, and for edits one undo step that Undo restores exactly. The settings,
 * selection and window actions are not part of the document: no undo step at all.
 */
import { describe, expect, it } from 'vitest';
import { MASTER, type InstrumentChannel, type Project } from '@core/model/types';
import { project, stackedSong, type TestServices } from '../../../../test/helpers/focus';
import { applyAnswer } from '../apply';
import type { AiAction } from '../schema';

const run = (s: TestServices, actions: AiAction[], dryRun = false) =>
  applyAnswer(s, { message: 'ok', actions }, { previousBeat: null, ...(dryRun ? { dryRun: true } : {}) });
const steps = (s: TestServices) => s.history.steps().done.length;
const snap = (s: TestServices) => structuredClone(project(s));
const instrument = (p: Project, name: string) =>
  Object.values(p.channels).find((c): c is InstrumentChannel => c.kind === 'instrument' && c.name === name)!;

/** Runs an editing answer and checks it made exactly one undo step that Undo and Redo restore exactly. */
function edit(s: TestServices, actions: AiAction[]) {
  const before = snap(s);
  const n = steps(s);
  const res = run(s, actions);
  expect(steps(s) - n, 'one undo step').toBe(1);
  expect(res.edited).toBe(true);
  const after = snap(s);
  s.history.undo();
  expect(snap(s), 'undo restores exactly').toEqual(before);
  s.history.redo();
  expect(snap(s), 'redo re-applies').toEqual(after);
  return res;
}

/** Runs an answer that must not touch the document: no undo step, nothing changed. */
function noEdit(s: TestServices, actions: AiAction[]) {
  const before = snap(s);
  const n = steps(s);
  const res = run(s, actions);
  expect(steps(s)).toBe(n);
  expect(res.edited).toBe(false);
  expect(snap(s)).toEqual(before);
  return res;
}

describe('settings', () => {
  it('changes the preferences and the editors’ settings, and reports them', () => {
    const { s } = stackedSong();
    const res = noEdit(s, [
      {
        op: 'settings',
        metronome: true,
        count_in_bars: 2,
        record_mode: 'replace',
        record_quantize: '1/16',
        record_notes: false,
        record_audio: true,
        follow_playhead: false,
        tooltips: false,
        typing_piano: true,
        piano_octave: 4,
        midi_input: true,
        audio_buffer: 'small',
        sample_memory_mb: 2048,
        scope: 'spectrum',
        input_channels: 'stereo',
        input_track: '3',
        monitor: true,
        latency_offset_ms: 12.5,
        export: { codec: 'flac', bits: 16, sample_rate: 44100, normalize: true, stems: true, master_chain: false, stems_to: 'zip', mp3_kbps: 128 },
        piano_roll: { tool: 'paint', snap: 'step', scale_snap: true, scale_highlight: false },
        playlist: { tool: 'select', snap: 'bar' },
      },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.ui).toHaveLength(1);
    expect(res.ui![0]).toMatch(/^Settings: metronome on, /);
    const p = s.prefs.getState();
    expect(p).toMatchObject({
      metronome: true,
      countInBars: 2,
      recordMode: 'replace',
      recordQuantize: 240,
      recordNotes: false,
      recordAudio: true,
      followPlayhead: false,
      tooltips: false,
      typingPiano: true,
      pianoOctave: 4,
      midiInput: true,
      audioBuffer: 'small',
      sampleMemoryMb: 2048,
      scopeMode: 'spectrum',
      audioInputChannels: 'stereo',
      audioMonitor: true,
      recordLatencyOffsetMs: 12.5,
      exportCodec: 'flac',
      exportFlacBits: 16,
      exportFormat: 'pcm16',
      exportSampleRate: 44100,
      exportNormalize: true,
      exportStems: true,
      exportMasterChain: false,
      exportStemsTo: 'zip',
      exportMp3Kbps: 128,
    });
    expect(p.audioInputTrack).toBe(project(s).mixer.order[3]);
    expect(s.editor.getState().pianoRoll).toMatchObject({ tool: 'paint', snap: 'step', scaleSnap: true, scaleHighlight: false });
    expect(s.editor.getState().playlist).toMatchObject({ tool: 'select', snap: 'bar' });
  });

  it('sets the accessibility options (interface size, contrast, motion, colour-blind safe colours) and refuses bad ones', () => {
    const { s } = stackedSong();
    const res = noEdit(s, [
      { op: 'settings', interface_size_percent: 125, high_contrast: 'on', reduce_motion: 'off', color_blind_safe: true },
    ]);
    expect(res.warnings).toEqual([]);
    expect(s.prefs.getState()).toMatchObject({ uiScale: 125, highContrast: 'on', reduceMotion: 'off', colorSafe: true });
    expect(res.ui[0]).toContain('interface size 125 percent');
    noEdit(s, [{ op: 'settings', interface_size_percent: 400 }]);
    expect(s.prefs.getState().uiScale).toBe(150);
    noEdit(s, [{ op: 'settings', interface_size_percent: 1 }]);
    expect(s.prefs.getState().uiScale).toBe(90);
    const bad = noEdit(s, [{ op: 'settings', high_contrast: 'maybe', reduce_motion: 'sometimes' }]);
    expect(bad.warnings.filter((w) => /high_contrast|reduce_motion/.test(w))).toHaveLength(2);
    expect(s.prefs.getState()).toMatchObject({ highContrast: 'on', reduceMotion: 'off' });
  });

  it('clamps numbers into their range', () => {
    const { s } = stackedSong();
    noEdit(s, [{ op: 'settings', count_in_bars: 9, sample_memory_mb: 1, piano_octave: 99, latency_offset_ms: 500 }]);
    expect(s.prefs.getState()).toMatchObject({ countInBars: 4, sampleMemoryMb: 256, pianoOctave: 9, recordLatencyOffsetMs: 200 });
  });

  it('refuses what it cannot use, says why, and changes the rest', () => {
    const { s } = stackedSong();
    const before = { ...s.prefs.getState() };
    const res = noEdit(s, [
      {
        op: 'settings',
        record_mode: 'sideways',
        audio_buffer: 'huge',
        record_quantize: '1/7',
        scope: 'oscilloscope',
        input_channels: 'quad',
        input_track: 'No such track',
        export: { codec: 'ogg', bits: 33, sample_rate: 11025, mp3_kbps: 99, stems_to: 'cloud' },
        piano_roll: { tool: 'lasso', snap: 'weekly' },
        metronome: true,
      },
    ]);
    expect(res.warnings.length).toBeGreaterThanOrEqual(10);
    expect(res.warnings.every((w) => w.startsWith('settings: '))).toBe(true);
    const now = s.prefs.getState();
    expect(now.metronome).toBe(true);
    expect({ ...now, metronome: before.metronome }).toEqual(before);
    expect(s.editor.getState().pianoRoll.tool).toBe('draw');
  });

  it('an empty settings action says so, and a dry run changes nothing', () => {
    const { s } = stackedSong();
    expect(noEdit(s, [{ op: 'settings' }]).warnings).toEqual(['settings: nothing to change (give a setting)']);
    const dry = run(s, [{ op: 'song', bpm: 100 }, { op: 'settings', metronome: true }], true);
    expect(dry.edited).toBe(false);
    expect(s.prefs.getState().metronome).toBe(false);
  });
});

describe('select', () => {
  it('selects the channel, mixer track and pattern, and the notes and clips of the song', () => {
    const { s } = stackedSong();
    const res = noEdit(s, [
      {
        op: 'select',
        channel: 'Pluck',
        insert: '2',
        pattern: 'Drop',
        notes: { from_bar: 1, to_bar: 1, from_key: 75, to_key: 80 },
        clips: { track: 1, from_bar: 37, to_bar: 40 },
      },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.ui![0]).toMatch(/^Selected channel “Pluck”, mixer track “Insert 2”, pattern “Drop”, 1 clip|2 clips/);
    const p = project(s);
    expect(s.session.getState().selectedChannelId).toBe(instrument(p, 'Pluck').id);
    expect(s.session.getState().selectedInsertId).toBe(p.mixer.order[2]);
    expect(p.patterns[s.view.getState().currentPatternId!]!.name).toBe('Drop');
    const picked = s.editor.getState().noteSelection;
    const pluck = Object.values(p.patterns[s.view.getState().currentPatternId!]!.notes[instrument(p, 'Pluck').id]!);
    expect(picked.length).toBe(pluck.filter((n) => n.tick < 3840 && n.key >= 75 && n.key <= 80).length);
    expect(picked.length).toBeGreaterThan(0);
    expect(s.editor.getState().clipSelection).toHaveLength(2);
  });

  it('selects by clip ids, every clip, and clears', () => {
    const { s } = stackedSong();
    const ids = Object.keys(project(s).playlist.clips).slice(0, 3);
    noEdit(s, [{ op: 'select', clips: { ids } }]);
    expect(s.editor.getState().clipSelection).toEqual(ids);
    noEdit(s, [{ op: 'select', clips: { all: true } }]);
    expect(s.editor.getState().clipSelection).toHaveLength(Object.keys(project(s).playlist.clips).length);
    noEdit(s, [{ op: 'select', loop: { section: 'Drop' } }]);
    expect(s.view.getState().loop).not.toBeNull();
    noEdit(s, [{ op: 'select', clear: 'all' }]);
    expect(s.editor.getState().clipSelection).toEqual([]);
    expect(s.editor.getState().noteSelection).toEqual([]);
    expect(s.view.getState().loop).toBeNull();
  });

  it('sets the loop region from bars, and reads a marker’s section', () => {
    const { s } = stackedSong();
    noEdit(s, [{ op: 'select', loop: { from_bar: 9, to_bar: 12 } }]);
    expect(s.view.getState().loop).toEqual({ start: 8 * 3840, end: 12 * 3840 });
    const markers = Object.values(project(s).playlist.markers).sort((a, b) => a.tick - b.tick);
    noEdit(s, [{ op: 'select', loop: { section: markers[1]!.name } }]);
    expect(s.view.getState().loop!.start).toBe(markers[1]!.tick);
    expect(s.view.getState().loop!.end).toBe(markers[2]!.tick);
  });

  it('works on what the same answer just made (@refs, the new pattern)', () => {
    const { s } = stackedSong();
    const res = run(s, [
      { op: 'add_channel', ref: '@lead', plugin: 'agstudio.pluck', name: 'New lead' },
      { op: 'add_pattern', ref: '@idea', name: 'Idea' },
      { op: 'write_notes', pattern: '@idea', channel: '@lead', notes: [{ step: 0, key: 60 }, { step: 4, key: 64 }, { step: 8, key: 67 }] },
      { op: 'select', notes: { pattern: '@idea', channel: '@lead', from_key: 62 } },
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.ui![0]).toContain('2 notes of “New lead” in “Idea”');
    expect(s.editor.getState().noteSelection).toHaveLength(2);
    expect(s.session.getState().selectedChannelId).toBe(instrument(project(s), 'New lead').id);
  });

  it('says what it could not find and leaves the rest as it was', () => {
    const { s } = stackedSong();
    s.session.getState().selectChannel(null);
    const res = noEdit(s, [
      {
        op: 'select',
        channel: 'Nobody',
        insert: '99',
        pattern: 'No pattern',
        clips: { ids: ['clip_nope'] },
        notes: { channel: 'Nobody' },
        loop: { section: 'Nowhere' },
        clear: 'sideways',
      },
      { op: 'select', loop: { from_bar: 8, to_bar: 3 } },
      { op: 'select', clips: {} },
      { op: 'select' },
    ]);
    expect(res.warnings.every((w) => w.startsWith('select: '))).toBe(true);
    expect(res.warnings.length).toBeGreaterThanOrEqual(8);
    expect(s.session.getState().selectedChannelId).toBeNull();
    expect(s.editor.getState().clipSelection).toEqual([]);
    expect(s.view.getState().loop).toBeNull();
    expect(res.ui).toBeUndefined();
  });

  it('refuses notes of a channel that has none to select (an audio channel)', () => {
    const { s } = stackedSong();
    const res = noEdit(s, [{ op: 'select', notes: { channel: Object.values(project(s).channels).find((c) => c.kind === 'automation')!.id } }]);
    expect(res.warnings[0]).toMatch(/^select: .*has no notes/);
  });
});

describe('open: close, focus, maximize, restore', () => {
  const show = (s: TestServices) => {
    s.view.getState().showWindow('mixer', 'mixer');
    s.view.getState().showWindow('playlist', 'playlist');
  };

  it('closes, focuses, maximizes and restores an open window; no undo step', () => {
    const { s } = stackedSong();
    show(s);
    expect(noEdit(s, [{ op: 'open', window: 'mixer', action: 'focus' }]).ui).toEqual(['Brought the mixer window to the front']);
    expect(s.view.getState().focusedId).toBe('mixer');
    noEdit(s, [{ op: 'open', window: 'mixer', action: 'maximize' }]);
    expect(s.view.getState().windows.mixer!.maximized).toBe(true);
    noEdit(s, [{ op: 'open', window: 'mixer', action: 'restore' }]);
    expect(s.view.getState().windows.mixer!.maximized).toBe(false);
    noEdit(s, [{ op: 'open', window: 'playlist', action: 'close' }]);
    expect(s.view.getState().windows.playlist!.visible).toBe(false);
  });

  it('shows and hides the browser panel', () => {
    const { s } = stackedSong();
    noEdit(s, [{ op: 'open', window: 'browser', action: 'close' }]);
    expect(s.view.getState().browser.visible).toBe(false);
    noEdit(s, [{ op: 'open', window: 'browser' }]);
    expect(s.view.getState().browser.visible).toBe(true);
  });

  it('opening still goes to the UI (after), for any window', () => {
    const { s } = stackedSong();
    expect(noEdit(s, [{ op: 'open', window: 'history' }]).after).toEqual([{ kind: 'open', window: 'history' }]);
    const ch = instrument(project(s), 'Pluck');
    expect(noEdit(s, [{ op: 'open', window: 'plugin', channel: 'Pluck' }]).after).toEqual([{ kind: 'open', window: 'plugin', channelId: ch.id }]);
  });

  it('closes a plugin window by its channel, and refuses what does not exist', () => {
    const { s } = stackedSong();
    const ch = instrument(project(s), 'Pluck');
    s.view.getState().showWindow(`plugin:${ch.id}`, 'plugin', { kind: 'channel', channelId: ch.id });
    noEdit(s, [{ op: 'open', window: 'plugin', channel: 'Pluck', action: 'close' }]);
    expect(s.view.getState().windows[`plugin:${ch.id}`]!.visible).toBe(false);
    const res = noEdit(s, [
      { op: 'open', window: 'garage' },
      { op: 'open', window: 'plugin' },
      { op: 'open', window: 'mixer', action: 'maximize' },
      { op: 'open', window: 'assistant' },
    ]);
    expect(res.warnings).toEqual([
      expect.stringMatching(/^open: there is no window "garage"/),
      'open: a plugin window needs its channel or effect',
      "open: the mixer window isn't open",
      expect.stringMatching(/^open: there is no window "assistant"/),
    ]);
  });
});

describe('save_preset', () => {
  it('saves a channel’s settings as the musician’s own preset, which loads back by name', () => {
    const { s } = stackedSong();
    run(s, [{ op: 'edit_channel', channel: 'Pluck', preset: 'Harp' }]);
    const n = steps(s);
    const res = noEdit(s, [{ op: 'save_preset', channel: 'Pluck', name: 'My harp' }]);
    expect(res.ui).toEqual(['Saved Pluck preset “My harp”']);
    expect(steps(s)).toBe(n);
    expect(s.presets.find('agstudio.pluck', 'My harp')).toBeDefined();
    run(s, [{ op: 'add_channel', ref: '@copy', plugin: 'agstudio.pluck', name: 'Copy', preset: 'My harp' }]);
    expect(instrument(project(s), 'Copy').plugin.params).toEqual(instrument(project(s), 'Pluck').plugin.params);
  });

  it('saves an effect’s settings, and refuses without a name or a target', () => {
    const { s } = stackedSong();
    const fx = project(s).mixer.inserts[MASTER]!.fx[1]!;
    expect(noEdit(s, [{ op: 'save_preset', effect: fx.id, name: 'Loud limit' }]).ui).toEqual(['Saved Limiter preset “Loud limit”']);
    const res = noEdit(s, [
      { op: 'save_preset', channel: 'Pluck' },
      { op: 'save_preset', name: 'No target' },
      { op: 'save_preset', channel: 'Nobody', name: 'x' },
    ]);
    expect(res.warnings).toHaveLength(3);
    expect(res.warnings.every((w) => w.startsWith('save preset: '))).toBe(true);
  });
});

describe('song: title and author', () => {
  it('sets them as one undo step, and "" removes the author', () => {
    const { s } = stackedSong();
    const res = edit(s, [{ op: 'song', title: 'Night drive', author: 'A. Guo' }]);
    expect(res.changes).toEqual(['Song: title “Night drive”, author A. Guo']);
    run(s, [{ op: 'song', title: 'Night drive', author: 'A. Guo' }]);
    expect(project(s).meta).toMatchObject({ title: 'Night drive', author: 'A. Guo' });
    run(s, [{ op: 'song', author: '' }]);
    expect(project(s).meta.author).toBeUndefined();
  });

  it('ignores junk', () => {
    const { s } = stackedSong();
    const title = project(s).meta.title;
    noEdit(s, [{ op: 'song', title: 5 as never, author: 7 as never }]);
    expect(project(s).meta.title).toBe(title);
  });
});

describe('edit_channel: sample, root_key, position', () => {
  it('swaps a sampler’s kit sound, sets the root key and moves the channel; one undo step', () => {
    const { s } = stackedSong();
    const before = instrument(project(s), 'Clap').plugin.samples!.main!;
    const res = edit(s, [{ op: 'edit_channel', channel: 'Clap', sample: 'snare', root_key: 62, position: 1 }]);
    expect(res.warnings).toEqual([]);
    run(s, [{ op: 'edit_channel', channel: 'Clap', sample: 'snare', root_key: 62, position: 1 }]);
    const p = project(s);
    const clap = instrument(p, 'Clap');
    expect(clap.plugin.samples!.main).not.toBe(before);
    expect(p.samples[clap.plugin.samples!.main!]!.name.toLowerCase()).toContain('snare');
    expect(clap.rootKey).toBe(62);
    expect(p.channelOrder[0]).toBe(clap.id);
  });

  it('refuses a sound that does not exist, a plugin without a sample and keeps the rest', () => {
    const { s } = stackedSong();
    const res = noEdit(s, [
      { op: 'edit_channel', channel: 'Kick', sample: 'didgeridoo' },
      { op: 'edit_channel', channel: '808', sample: 'kick' },
    ]);
    expect(res.warnings).toEqual(['there is no kit sound "didgeridoo"', '“808” doesn\'t play a sample']);
  });

  it('clamps a position beyond the rack to the end', () => {
    const { s } = stackedSong();
    edit(s, [{ op: 'edit_channel', channel: 'Kick', position: 500 }]);
    run(s, [{ op: 'edit_channel', channel: 'Kick', position: 500 }]);
    const p = project(s);
    expect(p.channelOrder[p.channelOrder.length - 1]).toBe(instrument(p, 'Kick').id);
  });
});

describe('edit_insert: position', () => {
  it('moves a mixer track, keeps Master first, and warns about Master', () => {
    const { s } = stackedSong();
    const p0 = project(s);
    const moving = p0.mixer.order[5]!;
    edit(s, [{ op: 'edit_insert', insert: moving, position: 2 }]);
    run(s, [{ op: 'edit_insert', insert: moving, position: 2 }]);
    expect(project(s).mixer.order[2]).toBe(moving);
    expect(project(s).mixer.order[0]).toBe('master');
    const res = noEdit(s, [{ op: 'edit_insert', insert: 'master', position: 4 }]);
    expect(res.warnings).toEqual(['the Master track stays first']);
  });
});

describe('add_pattern: copy and split; edit_pattern: position', () => {
  it('copies a pattern with its notes as one undo step', () => {
    const { s } = stackedSong();
    const res = edit(s, [{ op: 'add_pattern', ref: '@c', from: 'Drop', name: 'Drop B' }, { op: 'write_notes', pattern: '@c', channel: 'Kick', notes: [{ step: 3 }] }]);
    expect(res.changes[0]).toBe('Copied “Drop” as “Drop B”');
    run(s, [{ op: 'add_pattern', from: 'Drop' }]);
    const p = project(s);
    const copy = Object.values(p.patterns).find((x) => x.name === 'Drop copy')!;
    const drop = Object.values(p.patterns).find((x) => x.name === 'Drop')!;
    expect(Object.keys(copy.notes)).toEqual(Object.keys(drop.notes));
    const note = (x: typeof drop) => Object.values(Object.values(x.notes)[0]!).map((n) => [n.tick, n.key, n.velocity]);
    expect(note(copy)).toEqual(note(drop));
    // New note ids: editing the copy leaves the original alone.
    expect(Object.keys(Object.values(copy.notes)[0]!)).not.toEqual(Object.keys(Object.values(drop.notes)[0]!));
    expect(p.patternOrder.indexOf(copy.id)).toBe(p.patternOrder.indexOf(drop.id) + 1);
  });

  it('splits a pattern into one pattern per channel', () => {
    const { s } = stackedSong();
    const res = edit(s, [{ op: 'add_pattern', from: 'Drop', split_by_channel: true }]);
    expect(res.changes[0]).toMatch(/^Split “Drop” into \d+ patterns \(one per channel\)$/);
    run(s, [{ op: 'add_pattern', from: 'Drop', split_by_channel: true, name: 'Part' }]);
    const p = project(s);
    const parts = Object.values(p.patterns).filter((x) => x.name.startsWith('Part · '));
    const drop = Object.values(p.patterns).find((x) => x.name === 'Drop')!;
    expect(parts).toHaveLength(Object.values(drop.notes).filter((n) => Object.keys(n).length).length);
    for (const part of parts) {
      expect(Object.keys(part.notes)).toHaveLength(1);
      const cid = Object.keys(part.notes)[0]!;
      expect(Object.values(part.notes[cid as never]!).length).toBe(Object.values(drop.notes[cid as never]!).length);
      expect(part.name).toBe(`Part · ${p.channels[cid as never]!.name}`);
    }
  });

  it('refuses an empty or missing source', () => {
    const { s } = stackedSong();
    run(s, [{ op: 'add_pattern', ref: '@e', name: 'Empty' }]);
    const res = noEdit(s, [
      { op: 'add_pattern', from: 'Empty', split_by_channel: true },
      { op: 'add_pattern', from: 'Nowhere' },
    ]);
    expect(res.warnings).toEqual(['add pattern: “Empty” has no notes to split', 'add pattern: there is no pattern "Nowhere"']);
  });

  it('moves a pattern in the list', () => {
    const { s } = stackedSong();
    const last = project(s).patternOrder[project(s).patternOrder.length - 1]!;
    edit(s, [{ op: 'edit_pattern', pattern: last, position: 1 }]);
    run(s, [{ op: 'edit_pattern', pattern: last, position: 1 }]);
    expect(project(s).patternOrder[0]).toBe(last);
  });
});

describe('query', () => {
  it('runs a read tool after the edits and returns its result; no undo step', () => {
    const { s } = stackedSong();
    const res = noEdit(s, [{ op: 'query', tool: 'get_mixer', args_json: '{"insert":"master"}' }, { op: 'query', tool: 'get_transport' }]);
    expect(res.queries).toHaveLength(2);
    expect(res.queries![0]).toMatchObject({ tool: 'get_mixer', args: { insert: 'master' } });
    expect((res.queries![0]!.result as { inserts: { id: string }[] }).inserts[0]!.id).toBe('master');
    expect(res.queries![1]).toMatchObject({ tool: 'get_transport', args: {} });
  });

  it('sees what the same answer just changed', () => {
    const { s } = stackedSong();
    const res = run(s, [{ op: 'song', bpm: 99 }, { op: 'query', tool: 'get_transport' }]);
    expect((res.queries![0]!.result as { bpm: number }).bpm).toBe(99);
  });

  it('refuses bad arguments, an unknown tool and more than four look-ups', () => {
    const { s } = stackedSong();
    const res = noEdit(s, [
      { op: 'query', tool: 'get_mixer', args_json: '{nope' },
      { op: 'query', tool: 'get_mixer', args_json: '[1]' },
      { op: 'query', tool: 'get_everything' },
      { op: 'query', tool: 'get_windows' },
      { op: 'query', tool: 'get_windows' },
      { op: 'query', tool: 'get_windows' },
      { op: 'query', tool: 'get_windows' },
    ]);
    expect(res.warnings).toEqual([
      'query: args_json must be a JSON object (got {nope)',
      'query: args_json must be a JSON object (got [1])',
      'query: there is no read tool "get_everything"',
      'query: only 4 look-ups at a time',
    ]);
    expect(res.queries).toHaveLength(1);
  });

  it('a dry run looks up nothing', () => {
    const { s } = stackedSong();
    expect(run(s, [{ op: 'song', bpm: 99 }, { op: 'query', tool: 'get_windows' }], true).queries).toBeUndefined();
  });
});
