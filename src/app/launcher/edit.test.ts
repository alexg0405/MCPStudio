/**
 * Putting playlist clips and audio files into launcher slots: where they land, what is skipped, one undo step each.
 */
import { describe, expect, it } from 'vitest';
import { launcherFixture } from '@core/launcher/test-project';
import { newId } from '@core/model/ids';
import type { AudioClip, ClipId, LaneId, PatternClip, SampleRef } from '@core/model/types';
import { MAX_SCENES } from '@core/launcher/grid';
import { addClips } from '@core/ops/playlist';
import { createTestServices } from '../testing';
import { putAudioFilesAt, putClipsAt } from './edit';

function rig() {
  const f = launcherFixture();
  const project = { ...f.project };
  delete (project as { launcher?: unknown }).launcher;
  const s = createTestServices({ project });
  const lane = (i: number) => s.doc.getState().project.playlist.laneOrder[i] as LaneId;
  const slot = (track: number, scene: number) => {
    const l = s.doc.getState().project.launcher;
    return l?.tracks[l.trackOrder[track]!]?.slots[l.sceneOrder[scene]!];
  };
  const clips: { pattern: PatternClip; audio: AudioClip; audio2: AudioClip } = {
    pattern: { kind: 'pattern', id: newId.clip(), laneId: lane(0), start: 0, length: 3840, patternId: f.patterns[1]!, offset: 0 },
    audio: { kind: 'audio', id: newId.clip(), laneId: lane(1), start: 7680, length: 3840, channelId: f.audioId, offsetSec: 0.5 },
    audio2: { kind: 'audio', id: newId.clip(), laneId: lane(1), start: 3840, length: 1920, channelId: f.audioId, offsetSec: 0 },
  };
  s.history.transact('seed', (d) => addClips(d, [clips.pattern, clips.audio, clips.audio2]));
  return { f, s, slot, clips };
}

describe('putClipsAt', () => {
  it('puts the first clip (in time order) at the slot and the others below it, in one undo step', () => {
    const { s, slot, clips, f } = rig();
    const before = s.history.steps().done.length;
    const r = putClipsAt(s, [clips.audio.id, clips.pattern.id, clips.audio2.id], 2, 4);
    expect(r).toEqual({ placed: 3, skipped: 0 });
    // Time order: the pattern (tick 0), the short audio clip (3840), the audio clip (7680).
    expect(slot(2, 4)?.content).toEqual({ kind: 'pattern', patternId: f.patterns[1] });
    expect(slot(2, 5)?.content).toMatchObject({ kind: 'audio', channelId: f.audioId, offsetSec: 0, length: 1920 });
    expect(slot(2, 6)?.content).toMatchObject({ kind: 'audio', offsetSec: 0.5 });
    expect(s.doc.getState().project.launcher!.trackOrder.length).toBeGreaterThanOrEqual(8);
    expect(s.history.steps().done.length).toBe(before + 1);
    // The playlist is as it was.
    expect(Object.keys(s.doc.getState().project.playlist.clips)).toHaveLength(3);
  });

  it('skips clips that are gone, and says how many did not go', () => {
    const { s, slot, clips } = rig();
    const gone = 'clip_gone' as ClipId;
    const r = putClipsAt(s, [clips.pattern.id, gone], 0, 0);
    expect(r).toEqual({ placed: 1, skipped: 1 });
    expect(slot(0, 0)).toBeDefined();
    expect(slot(0, 1)).toBeUndefined();
    expect(putClipsAt(s, [gone], 0, 2)).toEqual({ placed: 0, skipped: 1 });
    expect(slot(0, 2)).toBeUndefined();
  });

  it('stops at the end of the grid instead of failing', () => {
    const { s, slot, clips } = rig();
    const r = putClipsAt(s, [clips.pattern.id, clips.audio2.id, clips.audio.id], 1, MAX_SCENES - 2);
    expect(r.placed).toBe(2);
    expect(slot(1, MAX_SCENES - 1)).toBeDefined();
    expect(putClipsAt(s, [clips.pattern.id], 1, MAX_SCENES)).toEqual({ placed: 0, skipped: 1 });
  });
});

describe('putAudioFilesAt', () => {
  const ref = (name: string, durationSec: number | undefined): SampleRef => ({
    id: newId.sample(),
    name,
    source: { kind: 'embedded', hash: name.padEnd(64, 'a'), ext: 'wav' },
    ...(durationSec !== undefined ? { durationSec } : {}),
  });
  const files = (...names: string[]) => names.map((name) => ({ name, arrayBuffer: async () => new ArrayBuffer(0) }));

  it('imports each file, makes an audio channel for it and fills the slots below the drop, in one undo step', async () => {
    const { s, slot } = rig();
    const before = s.history.steps().done.length;
    const channels = Object.keys(s.doc.getState().project.channels).length;
    const n = await putAudioFilesAt(s, Promise.resolve(files('a.wav', 'b.wav')), 1, 2, async (_s, f) => ref(f.name.replace('.wav', ''), f.name === 'a.wav' ? 1 : 2));
    expect(n).toBe(2);
    const p = s.doc.getState().project;
    expect(Object.keys(p.channels)).toHaveLength(channels + 2);
    const a = slot(1, 2)!.content;
    const b = slot(1, 3)!.content;
    if (a.kind !== 'audio' || b.kind !== 'audio') throw new Error('not audio');
    expect(p.channels[a.channelId]).toMatchObject({ kind: 'audioClip', name: 'a' });
    // One pass is the sound's length at the song's tempo (120 BPM: two beats, 1920 ticks, a second).
    expect([a.length, b.length]).toEqual([Math.round((p.transport.bpm * 960) / 60), Math.round((2 * p.transport.bpm * 960) / 60)]);
    expect(s.history.steps().done.length).toBe(before + 1);
    // Undo takes the channels, the samples and the slots away together.
    s.history.undo();
    const back = s.doc.getState().project;
    expect(Object.keys(back.channels)).toHaveLength(channels);
    expect(slot(1, 2)).toBeUndefined();
    expect(Object.keys(back.samples).includes(Object.keys(p.samples).find((k) => p.samples[k as keyof typeof p.samples]?.name === 'a')!)).toBe(false);
  });

  it('leaves out files that could not be imported or whose length is unknown, and does nothing when none is left', async () => {
    const { s, slot } = rig();
    const before = s.history.steps().done.length;
    const n = await putAudioFilesAt(s, files('bad.txt', 'noLength.wav', 'ok.wav'), 0, 0, async (_s, f) =>
      f.name === 'bad.txt' ? null : ref(f.name, f.name === 'noLength.wav' ? undefined : 0.5),
    );
    expect(n).toBe(1);
    expect(slot(0, 0)?.content.kind).toBe('audio');
    expect(slot(0, 1)).toBeUndefined();
    expect(await putAudioFilesAt(s, files('bad.txt'), 3, 3, async () => null)).toBe(0);
    expect(s.history.steps().done.length).toBe(before + 1);
  });
});
