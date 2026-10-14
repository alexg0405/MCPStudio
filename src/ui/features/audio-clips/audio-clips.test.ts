import { describe, expect, it } from 'vitest';
import { registerFeatures } from '@ui/features';
import { normalizeGain } from '@core/audio/envelope';
import type { AudioClip, ClipId, LaneId, SampleRef } from '@core/model/types';
import { createTestServices } from '@app/testing';
import { addAudioClip } from '@app/actions/samples';
import { normalizeClips, setFollowTempo, setPitch, setReverse, sliceAtTransients } from '@app/actions/audio-clips';

const SR = 48000;

/** A 2 s sound (120 BPM: 3840 ticks) as one audio clip at bar 2, and a trimmed copy at bar 5. */
function setup(audio?: Float32Array) {
  const s = createTestServices();
  registerFeatures(s);
  s.history.transact('Tempo', (d) => void (d.transport.bpm = 120));
  const ref: SampleRef = {
    id: 'smp_test000001' as SampleRef['id'],
    name: 'Loop',
    source: { kind: 'embedded', hash: 'a'.repeat(64), ext: 'wav' },
    durationSec: 2,
    sampleRate: SR,
    channels: 1,
  };
  const x = audio ?? new Float32Array(2 * SR);
  s.fakeEngine.sampleAudio.set('Loop', { sampleRate: SR, channels: [x], duration: x.length / SR });
  const lane = s.doc.getState().project.playlist.laneOrder[0] as LaneId;
  addAudioClip(s, ref, lane, 3840);
  const whole = Object.values(s.doc.getState().project.playlist.clips)[0] as AudioClip;
  const trimmed: AudioClip = { ...whole, id: 'clip_trimmed01' as ClipId, start: 4 * 3840, length: 960, offsetSec: 0.5 };
  s.history.transact('Copy', (d) => void (d.playlist.clips[trimmed.id] = trimmed));
  const clip = (id: ClipId) => s.doc.getState().project.playlist.clips[id] as AudioClip;
  return { s, whole: whole.id, trimmed: trimmed.id, channel: whole.channelId, clip };
}

describe('audio clip edits', () => {
  it('reverses a sound and keeps each clip on its part of the audio', () => {
    const { s, whole, trimmed, channel, clip } = setup();
    expect(clip(whole).length).toBe(3840);
    setReverse(s, channel, true);
    expect(s.history.status().undoLabel).toBe('Reverse');
    // The whole clip still plays all of it; the trimmed one (0.5–1 s of the 2 s sound) now starts at 1 s.
    expect(clip(whole)).toMatchObject({ offsetSec: 0, length: 3840 });
    expect(clip(trimmed).offsetSec).toBeCloseTo(1, 9);
    s.history.undo();
    expect(clip(trimmed).offsetSec).toBe(0.5);
  });

  it('resizes clips that play the whole sound when pitch or tempo follow changes its length', () => {
    const { s, whole, trimmed, channel, clip } = setup();
    setPitch(s, channel, 1200); // twice as fast
    expect(s.history.status().undoLabel).toBe('Pitch +12 st');
    expect(clip(whole).length).toBe(1920);
    expect(clip(trimmed).length).toBe(960); // a chosen length stays
    // Recorded at 60 BPM, following a 120 BPM song by resampling: twice as fast again (×2 pitch kept).
    setFollowTempo(s, channel, 'resample', 60);
    expect(clip(whole).length).toBe(960);
    setFollowTempo(s, channel, 'stretch', 60);
    // Stretch drops the pitch's speed change: one 60 BPM beat per song beat.
    expect(clip(whole).length).toBe(1920);
    expect(s.doc.getState().project.channels[channel]).toMatchObject({ stretch: 'stretch', sourceBpm: 60, pitch: 1200 });
  });

  it('normalizes to −0.3 dB from the part of the audio a clip plays', async () => {
    const x = new Float32Array(2 * SR);
    x[Math.round(0.2 * SR)] = 0.9; // outside the trimmed clip
    x[Math.round(0.6 * SR)] = 0.5; // inside it (0.5–1 s)
    const { s, whole, trimmed, clip } = setup(x);
    await normalizeClips(s, [clip(whole), clip(trimmed)]);
    expect(clip(whole).gain).toBeCloseTo(normalizeGain(Math.fround(0.9)), 9);
    expect(clip(trimmed).gain).toBeCloseTo(normalizeGain(0.5), 9);
    expect(s.history.status().undoLabel).toBe('Normalize clips');
  });

  it('slices at the hits it plays, each slice continuing where the last one ended', async () => {
    const x = new Float32Array(2 * SR);
    for (const t of [0.0, 0.5, 1.0, 1.5])
      for (let i = 0; i < 0.1 * SR; i++) x[Math.round(t * SR) + i] = 0.8 * Math.exp(-i / 1200) * Math.sin(i * 0.3);
    const { s, whole } = setup(x);
    const n = await sliceAtTransients(s, s.doc.getState().project.playlist.clips[whole] as AudioClip);
    expect(n).toBe(4);
    const slices = Object.values(s.doc.getState().project.playlist.clips)
      .filter((c): c is AudioClip => c.kind === 'audio' && c.start < 4 * 3840)
      .sort((a, b) => a.start - b.start);
    expect(slices.map((c) => Math.round(c.start / 96))).toEqual([40, 50, 60, 70]); // every 960 ticks from 3840
    slices.forEach((c, i) => expect(c.offsetSec).toBeCloseTo((c.start - 3840) / 1920, 3 - (i ? 1 : 0)));
    expect(slices.reduce((sum, c) => sum + c.length, 0)).toBe(3840);
  });

  it('runs as commands with arguments (what the AI uses)', async () => {
    const { s, whole, channel, clip } = setup();
    s.editor.getState().selectClips([whole]);
    s.commands.run('audioClip.gain', -6);
    expect(clip(whole).gain).toBeCloseTo(10 ** (-6 / 20), 6);
    s.commands.run('audioClip.fades', { in: 20, out: 250 });
    expect(clip(whole)).toMatchObject({ fadeIn: 0.02, fadeOut: 0.25 });
    s.commands.run('audioClip.pitch', -3);
    expect(s.doc.getState().project.channels[channel]).toMatchObject({ pitch: -300 });
    s.commands.run('audioClip.followTempo', { mode: 'resample', sourceBpm: 100 });
    await Promise.resolve();
    expect(s.doc.getState().project.channels[channel]).toMatchObject({ stretch: 'resample', sourceBpm: 100 });
    s.commands.run('audioClip.reverse', { clip: whole });
    expect(s.doc.getState().project.channels[channel]).toMatchObject({ reverse: true });
  });
});
