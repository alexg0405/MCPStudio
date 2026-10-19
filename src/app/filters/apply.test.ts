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

  /** The song with one earlier edit, so there is an undo step for the Studio's answer to fold the filter into. */
  async function filterAfterAnEdit(filterId: string) {
    const { s } = stackedSong();
    s.history.transact('prior', (d) => {
      d.meta.title = 'prior';
    });
    const before = project(s);
    const res = await applyFilter(s, filterId, { kind: 'range', from: 4 * BAR, to: 8 * BAR }, { amend: s.history.status().cursor });
    const p = project(s);
    return { s, before, p, res, channel: p.channels[res.channelId] as AudioClipChannel, clip: p.playlist.clips[res.clipId]! };
  }

  it('an effects filter borrows an empty mixer track for its effects and keeps its old name in the record', async () => {
    const { s, before, p, channel } = await filterAfterAnEdit('lofi');
    expect(channel.filter?.insert).toMatchObject({ made: false, name: 'Insert 1' });
    expect(channel.filter?.insert?.slots).toHaveLength(1);
    expect(Object.keys(p.mixer.inserts)).toHaveLength(Object.keys(before.mixer.inserts).length);
    expect(p.mixer.inserts[channel.filter!.insert!.id]!.name).toBe('Lo-fi');
    expect(channel.output).toBe(channel.filter!.insert!.id);
    expect(removeFilter(s, channel.id).ok).toBe(true);
    expect(project(s).mixer.inserts[channel.filter!.insert!.id]!.name).toBe('Insert 1');
  });

  it('Reverse keeps the tempo and plays the part backwards from the part’s own bar, on the track the part was on', async () => {
    const { before, p, channel, clip } = await filterAfterAnEdit('reverse');
    expect(channel.reverse).toBe(true);
    expect(channel.filter?.tempo).toBeUndefined();
    expect(p.transport).toEqual(before.transport);
    expect(clip).toMatchObject({ kind: 'audio', start: 4 * BAR, length: 4 * BAR, offsetSec: 0 });
    expect(p.playlist.laneOrder.indexOf(clip.laneId)).toBe(0);
    expect(p.playlist.laneOrder).toHaveLength(before.playlist.laneOrder.length);
  });

  it('a speed filter on a part makes a tempo clip and pitches the audio like a record; the answer’s undo step takes it all', async () => {
    const { s, p, res, channel } = await filterAfterAnEdit('slowed');
    expect(channel.pitch).toBeCloseTo(-281.358, 3);
    expect(channel.filter?.tempo).toMatchObject({ channelId: expect.any(String) });
    const tempoChannel = p.channels[(channel.filter!.tempo as { channelId: string }).channelId as never];
    expect(tempoChannel).toMatchObject({ kind: 'automation', target: { kind: 'tempo' } });
    expect(Object.values(p.playlist.clips).some((c) => c.kind === 'automation' && c.channelId === tempoChannel!.id)).toBe(true);
    // Folded into the earlier undo step (the Studio answer's), so the history has no extra entry.
    expect(s.history.steps().done.map((e) => e.label)).toEqual(['prior']);
    expect([...s.editor.getState().clipSelection]).toEqual([res.clipId]);
  });

  it('refuses an unknown filter and a part where nothing plays', async () => {
    const { s } = stackedSong();
    await expect(applyFilter(s, 'nope', { kind: 'range', from: 0, to: BAR })).rejects.toThrow('There is no filter called “nope”.');
    await expect(applyFilter(s, 'nightcore', { kind: 'range', from: 500 * BAR, to: 501 * BAR })).rejects.toThrow(/Nothing plays in/);
    expect(s.history.steps().done).toHaveLength(0);
  });
});
