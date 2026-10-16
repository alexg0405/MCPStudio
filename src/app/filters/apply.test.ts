import { describe, expect, it, vi } from 'vitest';
import { tempoMapOf } from '@core/automation/tempo';
import { newId } from '@core/model/ids';
import type { AudioClipChannel, Project, SampleRef } from '@core/model/types';
import type * as RenderToAudio from '../actions/render-to-audio';
import { BAR, project, stackedSong } from '../../../test/helpers/focus';

// Rendering needs a browser: the render is faked as a silent clip as long as the part plays.
let onRender: (() => void) | null = null;
vi.mock('../actions/render-to-audio', async (importOriginal) => {
  const orig = await importOriginal<typeof RenderToAudio>();
  return {
    ...orig,
    renderRange: vi.fn(async (_s: unknown, p: Project, from: number, to: number, name: string) => {
      onRender?.();
      const tempo = tempoMapOf(p, 'song');
      const seconds = tempo.tickToSeconds(to) - tempo.tickToSeconds(from);
      const ref: SampleRef = {
        id: newId.sample(),
        name,
        source: { kind: 'builtin', generator: 'kit/kick', version: 1 },
        durationSec: seconds,
        sampleRate: 48000,
        channels: 2,
      };
      return { ref, seconds, gain: 1 };
    }),
  };
});

const { applyFilter, removeFilter } = await import('./apply');

describe('sound filters (render faked)', () => {
  it('Nightcore on bars 5–8: one undo step that restores the song exactly; Remove filter does too', async () => {
    const { s } = stackedSong();
    const before = project(s);
    const steps = s.history.steps().done.length;
    const res = await applyFilter(s, 'nightcore', { kind: 'range', from: 4 * BAR, to: 8 * BAR });
    expect(s.history.steps().done).toHaveLength(steps + 1);
    const p = project(s);
    const ch = p.channels[res.channelId] as AudioClipChannel;
    // 25 % faster is about 3.9 semitones higher.
    expect(ch.pitch! / 100).toBeGreaterThan(3.8);
    expect(ch.pitch! / 100).toBeLessThan(4.0);
    expect(ch.filter).toMatchObject({ preset: 'nightcore', from: 4 * BAR, to: 8 * BAR });
    // The part is shorter by a fifth: everything after it arrives earlier.
    const t0 = tempoMapOf(before, 'song');
    const t1 = tempoMapOf(p, 'song');
    const partBefore = t0.tickToSeconds(8 * BAR) - t0.tickToSeconds(4 * BAR);
    expect((t1.tickToSeconds(8 * BAR) - t1.tickToSeconds(4 * BAR)) / partBefore).toBeCloseTo(0.8, 4);
    s.history.undo();
    expect(project(s)).toEqual(before);
    s.history.redo();
    expect(removeFilter(s, res.channelId).ok).toBe(true);
    const back = project(s);
    expect(back.playlist.clips).toEqual(before.playlist.clips);
    expect(back.channels).toEqual(before.channels);
    expect(back.transport).toEqual(before.transport);
    expect(back.mixer).toEqual(before.mixer);
  });

  it('nothing changes when another project is opened while it renders', async () => {
    const { s } = stackedSong();
    const other = { ...project(s), projectId: 'prj_other' as never };
    onRender = () => s.history.load(other);
    try {
      await expect(applyFilter(s, 'nightcore', { kind: 'range', from: 4 * BAR, to: 8 * BAR })).rejects.toThrow(/project/i);
    } finally {
      onRender = null;
    }
    expect(project(s)).toBe(other);
    expect(s.history.steps().done).toHaveLength(0);
  });
});
