/**
 * A pitch-corrected audio clip draws the waveform of its corrected render (and says so in its title), and the
 * recording's own waveform while the render is not ready or has no waveform yet.
 */
import { describe, expect, it } from 'vitest';
import type { AudioClip, AudioClipChannel, Clip, LaneId, Project, SampleId, SampleRef } from '@core/model/types';
import { createEmptyProject } from '@core/model/defaults';
import { audioClipTags } from './audio-clip';
import type { TimelineTheme } from '../../timeline/canvas';
import { Viewport } from '../../timeline/viewport';
import { drawClips } from './draw-clips';
import { produce } from 'immer';

const theme = new Proxy({} as Record<string, string>, { get: (_t, key) => (key === 'font' ? 'sans-serif' : '#808080') }) as unknown as TimelineTheme;

/** A context that accepts any drawing call. */
function ctx(): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {};
  return new Proxy(store, {
    get(t, key: string) {
      if (key in t) return t[key];
      if (key === 'measureText') return () => ({ width: 10 });
      if (key === 'createLinearGradient') return () => ({ addColorStop() {} });
      return () => undefined;
    },
    set(t, key: string, v) {
      t[key] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const ref = (id: string): SampleRef => ({ id: id as SampleId, name: id, source: { kind: 'embedded', hash: id.padEnd(64, '0'), ext: 'flac' } });

function setup(render: boolean) {
  const channel: AudioClipChannel = {
    kind: 'audioClip',
    id: 'ch_a' as AudioClipChannel['id'],
    name: 'Vocal',
    color: '#ffffff',
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    output: 'master' as never,
    sampleId: 'smp_own' as SampleId,
  };
  const clip: AudioClip = {
    kind: 'audio',
    id: 'clip_a' as AudioClip['id'],
    laneId: '' as LaneId,
    start: 0,
    length: 7680,
    channelId: channel.id,
    offsetSec: 0,
    pitchEdit: { notes: [{ from: 0, to: 1, pitch: 60, shift: 100 }], ...(render ? { renderedSampleId: 'smp_fix' as SampleId, renderedFor: 'x' } : {}) },
  };
  const project: Project = produce(createEmptyProject(), (d) => {
    d.channels[channel.id] = channel;
    d.samples['smp_own' as SampleId] = ref('smp_own');
    d.samples['smp_fix' as SampleId] = ref('smp_fix');
    clip.laneId = d.playlist.laneOrder[0] as LaneId;
    d.playlist.clips[clip.id] = clip;
  });
  const vp = new Viewport(8);
  vp.width = 600;
  vp.height = 100;
  vp.rowHeight = 60;
  vp.pxPerTick = 0.05;
  return { project, clip, channel, vp };
}

const wave = { peaks: new Float32Array(8), duration: 4 } as never;

describe('the waveform of a pitch-corrected clip', () => {
  it('asks for the render first', () => {
    const { project, clip, vp } = setup(true);
    const asked: string[] = [];
    const lane = clip.laneId;
    drawClips(ctx(), vp, theme, project, [clip as Clip], new Map([[lane, 0]]), { selected: new Set(), waveform: (r) => (asked.push(r.id), wave) }, new Set());
    expect(asked[0]).toBe('smp_fix');
    expect(asked).not.toContain('smp_own');
  });

  it('falls back to the recording while the render has no waveform', () => {
    const { project, clip, vp } = setup(true);
    const asked: string[] = [];
    drawClips(ctx(), vp, theme, project, [clip as Clip], new Map([[clip.laneId, 0]]), { selected: new Set(), waveform: (r) => (asked.push(r.id), r.id === 'smp_own' ? wave : null) }, new Set());
    expect(asked).toEqual(['smp_fix', 'smp_own']);
  });

  it('a clip without a render draws the recording, and only a rendered one is tagged', () => {
    const { project, clip, vp, channel } = setup(false);
    const asked: string[] = [];
    drawClips(ctx(), vp, theme, project, [clip as Clip], new Map([[clip.laneId, 0]]), { selected: new Set(), waveform: (r) => (asked.push(r.id), wave) }, new Set());
    expect(asked).toEqual(['smp_own']);
    const tempo = { bpmAt: () => 120 } as never;
    expect(audioClipTags(clip, channel, tempo, false)).not.toContain('Pitch corrected');
    const rendered = setup(true);
    expect(audioClipTags(rendered.clip, rendered.channel, tempo, false)).toContain('Pitch corrected');
  });
});
