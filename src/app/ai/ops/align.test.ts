import { produce } from 'immer';
import { afterEach, describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../../test/helpers/audio';
import { makeScenario } from '../../../../test/helpers/align-scenario';
import type { AudioClip, ClipId } from '@core/model/types';
import { startAlignRenderer } from '../../actions/align';
import { alignState } from '../../align/state';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';

const SR = 48000;

/** A lead on track 1 and two doubles on tracks 2 and 3. */
function setup() {
  const scenario = makeScenario({ sampleRate: SR, seed: 3, syllables: 4, jitterSec: 0.08 });
  const samples = new TestSamples();
  const leadRef = samples.add([scenario.lead], SR, 'lead vocal');
  const doubleRef = samples.add([scenario.double], SR, 'double vocal');
  const harmonyRef = samples.add([scenario.double], SR, 'harmony vocal');
  const length = 3840 * 2;
  const a = audioClipProject(leadRef, [{ start: 0, length, lane: 0 }]);
  const b = audioClipProject(doubleRef, [{ start: 0, length, lane: 1 }]);
  const c = audioClipProject(harmonyRef, [{ start: 0, length, lane: 2 }]);
  const project = produce(a.project, (d) => {
    [b, c].forEach((other, i) => {
      for (const ref of Object.values(other.project.samples)) d.samples[ref.id] = ref;
      d.channels[other.channelId] = other.project.channels[other.channelId]!;
      d.channelOrder.push(other.channelId);
      // Each project made its own tracks: the clip goes on this project's track number i + 2.
      for (const id of other.clipIds) d.playlist.clips[id] = { ...other.project.playlist.clips[id]!, laneId: d.playlist.laneOrder[i + 1]! };
    });
  });
  const s = createTestServices();
  for (const [name, x] of [['lead vocal', scenario.lead], ['double vocal', scenario.double], ['harmony vocal', scenario.double]] as const) {
    s.fakeEngine.sampleAudio.set(name, { sampleRate: SR, channels: [x], duration: x.length / SR });
  }
  s.history.load(project);
  return { s, leadClip: a.clipIds[0] as ClipId, one: b.clipIds[0] as ClipId, two: c.clipIds[0] as ClipId };
}
const run = (s: ReturnType<typeof createTestServices>, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const clipOf = (s: ReturnType<typeof createTestServices>, id: ClipId) => s.doc.getState().project.playlist.clips[id] as AudioClip;

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  alignState.setState({ rendering: {}, problems: {}, lastStats: {}, windowClip: null });
});

describe('the align_clips, tighten_timing and remove_alignment actions', () => {
  it('aligns clips by id or by track to a guide by id or by track, in one undo step, with the settings', () => {
    const { s, leadClip, one, two } = setup();
    const before = s.history.steps().done.length;
    const res = run(s, [{ op: 'align_clips', guide: leadClip, clips: [one], tightness: 85, pitch: 40 }]);
    expect(res.warnings).toEqual([]);
    expect(clipOf(s, one).align).toMatchObject({ mode: 'guide', guide: leadClip, tightness: 85, pitch: 40 });
    expect(s.history.steps().done.length).toBe(before + 1);
    // By track number: the lead on track 1 (at its first bar), the clip on track 3.
    const second = run(s, [{ op: 'align_clips', guide_track: 1, tracks: [3] }]);
    expect(second.warnings).toEqual([]);
    expect(clipOf(s, two).align).toMatchObject({ mode: 'guide', guide: leadClip, tightness: 70 });
    expect(clipOf(s, two).align?.pitch).toBeUndefined();
    s.history.undo();
    expect(clipOf(s, two).align).toBeUndefined();
    expect(clipOf(s, one).align?.tightness).toBe(85);
  });

  it('refuses a guide that is not an audio clip, a clip aligned to itself, and says why', () => {
    const { s, leadClip, one } = setup();
    expect(run(s, [{ op: 'align_clips', guide: leadClip, clips: [leadClip] }]).warnings.join(' ')).toMatch(/itself/);
    const bad = run(s, [{ op: 'align_clips', guide: 'clip_nope', clips: [one] }]);
    expect(bad.warnings.join(' ')).toMatch(/no clip/);
    expect(clipOf(s, one).align).toBeUndefined();
    const missing = run(s, [{ op: 'align_clips', guide: leadClip }]);
    expect(missing.warnings.join(' ')).toMatch(/which clips/);
  });

  it('tightens to the grid by strength and grid name, and removes the alignment', () => {
    const { s, one, two } = setup();
    const res = run(s, [{ op: 'tighten_timing', clip: one, strength: 60, grid: '1/8' }]);
    expect(res.warnings).toEqual([]);
    expect(clipOf(s, one).align).toMatchObject({ mode: 'grid', strength: 60, stepTicks: 480 });
    const bad = run(s, [{ op: 'tighten_timing', clip: two, grid: '1/7' }]);
    expect(bad.warnings.join(' ')).toMatch(/unknown grid/);
    expect(clipOf(s, two).align).toBeUndefined();
    const gone = run(s, [{ op: 'remove_alignment', clips: [one] }]);
    expect(gone.warnings).toEqual([]);
    expect(clipOf(s, one).align).toBeUndefined();
    expect(run(s, [{ op: 'remove_alignment', clips: [one] }]).warnings.join(' ')).toMatch(/none of those/);
  });

  it('the get_alignment read says what is aligned and the state of its render', async () => {
    const { s, leadClip, one } = setup();
    stop = startAlignRenderer(s);
    const empty = runReadTool(s, 'get_alignment', {}) as { aligned: unknown[]; message?: string };
    expect(empty.aligned).toEqual([]);
    expect(empty.message).toMatch(/align_clips/);
    run(s, [{ op: 'align_clips', guide: leadClip, clips: [one], tightness: 90, pitch: 30 }]);
    const waiting = runReadTool(s, 'get_alignment', { clip: one }) as Record<string, unknown>;
    expect(waiting).toMatchObject({ clip: one, mode: 'guide', guide: leadClip, guide_track: 1, tightness: 90, pitch_percent: 30, track: 2 });
    expect(['out of date', 'rendering']).toContain(waiting.state);
    const t0 = Date.now();
    while (!clipOf(s, one).align?.renderedSampleId) {
      if (Date.now() - t0 > 60_000) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
    const ready = runReadTool(s, 'get_alignment', { clip: one }) as Record<string, unknown> & { moved: { max_ms: number } };
    expect(ready.state).toBe('ready');
    expect(ready.hearing).toBe('aligned sound');
    expect(ready.moved.max_ms).toBeGreaterThan(0);
    expect((runReadTool(s, 'get_alignment', {}) as { aligned: unknown[] }).aligned).toHaveLength(1);
    expect(runReadTool(s, 'get_alignment', { clip: 'nope' })).toMatchObject({ error: expect.stringMatching(/no audio clip/) });
  }, 120_000);
});
