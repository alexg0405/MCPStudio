import { describe, expect, it } from 'vitest';
import { registerFeatures } from '@ui/features';
import { createTestServices } from '@app/testing';
import { audioClipProject, TestSamples } from '../../../../test/helpers/audio';
import { BEATS, drumLoop, TRANSCRIBE_RATE } from '../../../../test/helpers/transcribe-signals';
import type { AudioClip, ClipId } from '@core/model/types';
import { forgetListening } from '@app/transcribe/listening';
import { forgetPlans } from '@app/transcribe/plan-cache';
import { getMenuItems, type MenuItem } from '../../shell/menus';
import { extraMenuItems } from '../../context-menus';
import { convertStore } from './convert-store';
import { fieldsFor, gridIdOfTicks, initialState, instrumentChannels, settingsOf, specOf } from './dialog-model';

describe('the dialog\'s state becomes settings', () => {
  it('starts with the defaults of a conversion: 1/16, full strength, straightened, whole semitones', () => {
    const settings = settingsOf(initialState('melody'));
    expect(settings).toMatchObject({ mode: 'melody', sensitivity: 0.5, articulation: 'natural', keepCents: false, quantize: { gridTicks: 240, strength: 1, swing: 'straighten' } });
  });

  it('turns the choices into ticks, fractions and flags', () => {
    const state = { ...initialState('chords'), gridId: '1/8t', strength: 40, swing: 'keep' as const, sensitivity: 80, fillChordTrack: true, chordBass: true };
    const settings = settingsOf(state);
    expect(settings.quantize).toEqual({ gridTicks: 320, strength: 0.4, swing: 'keep' });
    expect(settings.sensitivity).toBe(0.8);
    expect(settings.fillChordTrack).toBe(true);
    expect(settingsOf({ ...state, mode: 'melody' }).fillChordTrack).toBe(false);
    expect(gridIdOfTicks(250)).toBe('1/16');
  });

  it('shows the controls a mode uses and hides the rest', () => {
    const fresh = initialState();
    expect(fieldsFor('melody', fresh)).toMatchObject({ noteEnds: true, chords: false, pads: false, sensitivity: true });
    expect(fieldsFor('drums', fresh)).toMatchObject({ noteEnds: false, pads: true });
    expect(fieldsFor('drums', { target: { kind: 'channel', channel: 'ch_x' as never } }).pads).toBe(false);
    expect(fieldsFor('chords', fresh)).toMatchObject({ chords: true, sensitivity: false });
  });

  it('asks for a channel when an existing one is the target and none is chosen', () => {
    const state = { ...initialState(), target: { kind: 'channel' as const, channel: '' as const } };
    expect(specOf('clip_a' as ClipId, state)).toEqual({ problem: expect.stringMatching(/Choose the channel/) });
    const ok = specOf('clip_a' as ClipId, initialState('drums'));
    expect(ok).toMatchObject({ clip: 'clip_a', target: { kind: 'new' }, place: true, muteOriginal: false, slicePads: true });
  });
});

describe('where Convert to MIDI is', () => {
  const SR = TRANSCRIBE_RATE;

  function setup() {
    forgetListening();
    forgetPlans();
    const loop = drumLoop({ bpm: 120, bars: 2, patterns: [BEATS.house ?? []] });
    const samples = new TestSamples();
    const ref = samples.add([loop.mono], SR, 'Beat');
    const { project, clipIds } = audioClipProject(ref, [{ start: 0, length: 3840 * 2 }]);
    const s = createTestServices();
    registerFeatures(s);
    s.fakeEngine.sampleAudio.set('Beat', { sampleRate: SR, channels: [loop.mono], duration: loop.mono.length / SR });
    s.history.load(project);
    return { s, clipId: clipIds[0] as ClipId };
  }

  it('is in an audio clip\'s menu, the Playlist menu and the command catalog', () => {
    const { s, clipId } = setup();
    const clip = s.doc.getState().project.playlist.clips[clipId] as AudioClip;
    const entries = extraMenuItems('playlist.clip', { clip } as never, s);
    expect(entries.some((e) => 'label' in e && e.label === 'Convert to MIDI…')).toBe(true);
    const inPlaylistMenu = (getMenuItems('playlist') as MenuItem[]).some((item) => item.kind === 'command' && item.command === 'audioToMidi.convert');
    expect(inPlaylistMenu).toBe(true);
    const command = s.commands.list().find((c) => c.id === 'audioToMidi.convert');
    expect(command?.hint).toMatch(/Turns the selected audio clip/);
    expect(command?.argsHint).toMatch(/mode\?/);
  });

  it('opens the dialog for the clip without a mode, and converts without a dialog with one', async () => {
    const { s, clipId } = setup();
    s.commands.run('audioToMidi.convert', { clip: clipId });
    expect(convertStore.getState().open).toEqual({ clipId });
    convertStore.setState({ open: null });
    const before = s.history.steps().done.length;
    s.commands.run('audioToMidi.convert', { clip: clipId, mode: 'drums' });
    // The listening runs in the background: wait for the pattern to appear.
    for (let i = 0; i < 200 && s.history.steps().done.length === before; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(convertStore.getState().open).toBeNull();
    expect(s.history.steps().done.length).toBe(before + 1);
    expect(Object.values(s.doc.getState().project.playlist.clips).some((c) => c.kind === 'pattern')).toBe(true);
    expect(instrumentChannels(s.doc.getState().project).map((c) => c.name)).toEqual(['Beat · Drums']);
  });

  it('says what to do when no audio clip is selected and none is named', () => {
    const { s } = setup();
    s.commands.run('audioToMidi.convert', undefined);
    expect(s.session.getState().toasts.at(-1)?.text).toMatch(/Select the audio clip/);
  });
});
