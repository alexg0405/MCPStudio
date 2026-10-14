import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createEmptyProject, DEFAULT_CHANNEL_VOLUME } from '../model/defaults';
import { newId } from '../model/ids';
import { MASTER, type AudioClip, type AudioClipChannel, type ClipId, type Project, type SampleId } from '../model/types';
import { setAudioChannelEdits, setAudioClipEdits } from './audio-edits';
import { addMarker, markersSorted, moveMarker, removeMarker, renameMarker } from './markers';

describe('markers', () => {
  it('adds, renames, moves and removes named song positions', () => {
    let p = createEmptyProject();
    let drop = '' as ReturnType<typeof addMarker>;
    p = produce(p, (d) => {
      addMarker(d, 3840 * 8, 'Verse');
      drop = addMarker(d, 3840 * 16.4, '  Drop  ', { color: '#e5574d' });
      addMarker(d, -10, '');
    });
    expect(markersSorted(p).map((m) => [m.tick, m.name])).toEqual([
      [0, 'Marker'],
      [30720, 'Verse'],
      [62976, 'Drop'],
    ]);
    p = produce(p, (d) => {
      renameMarker(d, drop, 'x'.repeat(100));
      moveMarker(d, drop, 3840 * 4);
    });
    expect(p.playlist.markers[drop]).toMatchObject({ tick: 15360, name: 'x'.repeat(64), color: '#e5574d' });
    p = produce(p, (d) => removeMarker(d, drop));
    expect(markersSorted(p)).toHaveLength(2);
  });
});

describe('audio edits', () => {
  const withAudio = (): { p: Project; clipId: ClipId } => {
    const base = createEmptyProject();
    const clipId = newId.clip();
    const p = produce(base, (d) => {
      const sampleId = 'smp_test' as SampleId;
      d.samples[sampleId] = { id: sampleId, name: 'Loop', source: { kind: 'builtin', generator: 'kit/kick' } } as never;
      const ch: AudioClipChannel = {
        kind: 'audioClip',
        id: newId.channel(),
        name: 'Loop',
        color: '#888888',
        muted: false,
        solo: false,
        volume: DEFAULT_CHANNEL_VOLUME,
        pan: 0,
        output: MASTER,
        sampleId,
      };
      d.channels[ch.id] = ch;
      d.channelOrder.push(ch.id);
      const clip: AudioClip = {
        kind: 'audio',
        id: clipId,
        laneId: d.playlist.laneOrder[0]!,
        start: 0,
        length: 3840,
        channelId: ch.id,
        offsetSec: 0,
      };
      d.playlist.clips[clipId] = clip;
    });
    return { p, clipId };
  };

  it('sets clip gain and fades, clamped, and drops neutral values', () => {
    const { p, clipId } = withAudio();
    const a = produce(p, (d) => setAudioClipEdits(d, clipId, { gain: 9, fadeIn: 0.02, fadeOut: -3 }));
    expect(a.playlist.clips[clipId]).toMatchObject({ gain: 4, fadeIn: 0.02 });
    expect(a.playlist.clips[clipId]).not.toHaveProperty('fadeOut');
    const b = produce(a, (d) => setAudioClipEdits(d, clipId, { gain: 1, fadeIn: 0 }));
    expect(b.playlist.clips[clipId]).not.toHaveProperty('gain');
    expect(b.playlist.clips[clipId]).not.toHaveProperty('fadeIn');
  });

  it('sets channel pitch, reverse and stretch', () => {
    const { p, clipId } = withAudio();
    const id = (p.playlist.clips[clipId] as AudioClip).channelId;
    const a = produce(p, (d) =>
      setAudioChannelEdits(d, id, { pitch: -350, reverse: true, stretch: 'stretch', sourceBpm: 2000 }),
    );
    expect(a.channels[id]).toMatchObject({ pitch: -350, reverse: true, stretch: 'stretch', sourceBpm: 999 });
    const b = produce(a, (d) => setAudioChannelEdits(d, id, { pitch: 0, reverse: false, stretch: 'off' }));
    for (const key of ['pitch', 'reverse', 'stretch']) expect(b.channels[id]).not.toHaveProperty(key);
  });
});
