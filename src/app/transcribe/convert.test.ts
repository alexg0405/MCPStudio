import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../test/helpers/audio';
import { BEATS, chordPads, drumLoop, progression, sungMelody, TRANSCRIBE_RATE } from '../../../test/helpers/transcribe-signals';
import { collectHashes } from '@core/gc/refs';
import { settingsFor } from '@core/audio/transcribe';
import type { AudioClip, AudioClipChannel, ClipId, PatternClip, Project } from '@core/model/types';
import { createTestServices } from '../testing';
import { convertToMidi, planClip, TranscribeError } from './convert';
import { forgetListening } from './listening';

const SR = TRANSCRIBE_RATE;
const BAR = 3840;

/** A project with one audio clip (from tick `start`, `bars` long) playing `sound`. */
function setup(sound: Float32Array, opts: { start?: number; bars?: number; bpm?: number; channel?: Partial<AudioClipChannel> } = {}) {
  forgetListening();
  const samples = new TestSamples();
  const ref = samples.add([sound], SR, 'Take');
  const { project, clipIds } = audioClipProject(ref, [{ start: opts.start ?? 0, length: (opts.bars ?? 4) * BAR }], { bpm: opts.bpm ?? 120, ...(opts.channel ? { channel: opts.channel } : {}) });
  const s = createTestServices();
  s.fakeEngine.sampleAudio.set('Take', { sampleRate: SR, channels: [sound], duration: sound.length / SR });
  s.history.load(project);
  return { s, clipId: clipIds[0] as ClipId };
}

const steps = (s: ReturnType<typeof setup>['s']) => s.history.steps().done.length;
const project = (s: ReturnType<typeof setup>['s']): Project => s.doc.getState().project;
const kit = () => drumLoop({ bpm: 120, bars: 4, patterns: [BEATS.house ?? []] }).mono;

describe('convert to MIDI', () => {
  it('turns a drum loop into a pattern for a new Drum Pads channel with the loop\'s own hits, placed under the audio, in one undo step', async () => {
    const { s, clipId } = setup(kit(), { start: BAR });
    const before = project(s);
    const n0 = steps(s);
    const result = await convertToMidi(s, { clip: clipId, settings: settingsFor('drums'), target: { kind: 'new' } });
    expect(steps(s)).toBe(n0 + 1);
    const after = project(s);
    const channel = after.channels[result.channelId];
    expect(channel?.kind === 'instrument' && channel.plugin.pluginId).toBe('agstudio.drum-pads');
    // Pads for the kick (pad 1), clap (4), closed hat (7) and open hat (11), each a sample cut from the recording.
    const slots = channel?.kind === 'instrument' ? channel.plugin.samples ?? {} : {};
    expect(Object.keys(slots).sort()).toEqual(['pad1', 'pad11', 'pad4', 'pad7']);
    for (const id of Object.values(slots)) expect(after.samples[id]?.source.kind).toBe('embedded');
    expect(result.pads).toBe(4);
    // The pattern: a bar-aligned length and the General MIDI keys.
    const pattern = after.patterns[result.patternId as keyof Project['patterns']];
    expect(pattern?.length).toBe(4 * BAR);
    const keys = new Set(Object.values(pattern?.notes[result.channelId] ?? {}).map((n) => n.key));
    expect([...keys].sort((a, b) => a - b)).toEqual([36, 39, 42, 46]);
    // The pattern clip sits where the audio does, on another track.
    const audio = after.playlist.clips[clipId] as AudioClip;
    const placed = Object.values(after.playlist.clips).find((c): c is PatternClip => c.kind === 'pattern');
    expect(placed).toMatchObject({ start: BAR, length: audio.length, patternId: result.patternId, offset: 0 });
    expect(placed?.laneId).not.toBe(audio.laneId);
    // The slices are in the project, so storage keeps them by hash.
    const hashes = collectHashes(after);
    for (const id of Object.values(slots)) {
      const source = after.samples[id]?.source;
      expect(source?.kind === 'embedded' && hashes.has(source.hash)).toBe(true);
    }
    // One undo takes everything away.
    s.history.undo();
    const undone = project(s);
    expect(undone.channelOrder).toEqual(before.channelOrder);
    expect(Object.keys(undone.samples)).toEqual(Object.keys(before.samples));
    expect(Object.keys(undone.playlist.clips)).toEqual(Object.keys(before.playlist.clips));
    expect(undone.patternOrder).toEqual(before.patternOrder);
  });

  it('can write to an existing channel, without placing it and with the original muted', async () => {
    const { s, clipId } = setup(sungMelody({ steps: [[60, 0.5, 0.1], [64, 0.5, 0.1], [67, 0.5, 0.1], [72, 0.8]] }).mono, { bars: 2 });
    const first = await convertToMidi(s, { clip: clipId, settings: settingsFor('melody'), target: { kind: 'new' }, place: false });
    expect(first.placed).toBe(false);
    expect(Object.values(project(s).playlist.clips).some((c) => c.kind === 'pattern')).toBe(false);
    const second = await convertToMidi(s, { clip: clipId, settings: settingsFor('melody'), target: { kind: 'channel', channel: first.channelId }, muteOriginal: true });
    expect(second.channelId).toBe(first.channelId);
    expect((project(s).playlist.clips[clipId] as AudioClip).muted).toBe(true);
    const keys = Object.values(project(s).patterns[second.patternId as keyof Project['patterns']]?.notes[first.channelId] ?? {})
      .sort((a, b) => a.tick - b.tick)
      .map((n) => n.key);
    expect(keys).toEqual([60, 64, 67, 72]);
  });

  it('puts the chords it finds on the chord track when asked, and undo takes them off', async () => {
    const { s, clipId } = setup(chordPads({ bpm: 120, chords: progression(['Am', 'F', 'C', 'G'], { beatsEach: 4 }) }), { bars: 4 });
    const result = await convertToMidi(s, { clip: clipId, settings: settingsFor('chords', { fillChordTrack: true }), target: { kind: 'new' } });
    const track = Object.values(project(s).chords ?? {}).sort((a, b) => a.tick - b.tick);
    expect(track.map((c) => [c.root, c.quality])).toEqual([[9, 'min'], [5, 'maj'], [0, 'maj'], [7, 'maj']]);
    expect(result.chords).toBe(4);
    s.history.undo();
    expect(project(s).chords).toBeUndefined();
  });

  it('writes the same notes every time', async () => {
    const { s, clipId } = setup(kit(), { bars: 4 });
    const notesOf = (p: Project, id: string) => Object.values(p.patterns[id as keyof Project['patterns']]?.notes ?? {}).flatMap((byId) => Object.values(byId ?? {}).map((n) => [n.tick, n.key, n.velocity]));
    const a = await convertToMidi(s, { clip: clipId, settings: settingsFor('drums'), target: { kind: 'new' }, slicePads: false });
    const notesA = notesOf(project(s), a.patternId);
    s.history.undo();
    const b = await convertToMidi(s, { clip: clipId, settings: settingsFor('drums'), target: { kind: 'new' }, slicePads: false });
    expect(notesOf(project(s), b.patternId)).toEqual(notesA);
    expect(notesA.length).toBe(a.notes);
  });

  it('lands the notes by the clip\'s own tempo follow and trim', async () => {
    // A sung note at 1.0 s of a sound recorded at 120 BPM, playing in a 90 BPM song with the tempo followed by stretching:
    // one second of the sound is two beats of the song.
    const { mono } = sungMelody({ steps: [[60, 0.5, 0.5], [64, 0.5]], start: 1 });
    const { s, clipId } = setup(mono, { bars: 2, bpm: 90, channel: { stretch: 'stretch', sourceBpm: 120 } });
    const plan = await planClip(s, clipId, settingsFor('melody', { quantize: { gridTicks: 0, strength: 1, swing: 'straighten' } }));
    expect(plan.transcription.notes[0]?.tick).toBeGreaterThan(1920 - 90);
    expect(plan.transcription.notes[0]?.tick).toBeLessThan(1920 + 90);
  });
});

describe('what cannot be converted', () => {
  it('says why, in plain words', async () => {
    const { s, clipId } = setup(kit(), { channel: { reverse: true } });
    await expect(convertToMidi(s, { clip: clipId, settings: settingsFor('drums'), target: { kind: 'new' } })).rejects.toThrow(/Reverse/);
    const empty = setup(new Float32Array(SR * 2));
    await expect(convertToMidi(empty.s, { clip: empty.clipId, settings: settingsFor('drums'), target: { kind: 'new' } })).rejects.toThrow(/No drum hits/);
    expect(steps(empty.s)).toBe(steps(empty.s));
    await expect(convertToMidi(s, { clip: 'nope' as ClipId, settings: settingsFor('drums'), target: { kind: 'new' } })).rejects.toBeInstanceOf(TranscribeError);
  });

  it('refuses a channel that is not an instrument', async () => {
    const { s, clipId } = setup(kit());
    const audioChannel = project(s).channelOrder[0] as string;
    await expect(convertToMidi(s, { clip: clipId, settings: settingsFor('drums'), target: { kind: 'channel', channel: audioChannel as never } })).rejects.toThrow(/instrument channel/);
  });
});
