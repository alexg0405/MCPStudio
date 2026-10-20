import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../../test/helpers/audio';
import { syntheticPhrase } from '@core/audio/cleanup/test-signals';
import type { AudioClip, ClipId } from '@core/model/types';
import { cleanupState } from '../../cleanup/state';
import { createTestServices } from '../../testing';
import { applyAnswer } from '../apply';
import { runReadTool } from '../read';
import type { AiAction } from '../schema';

const SR = 48000;

function setup() {
  const phrase = syntheticPhrase({ seconds: 6, seed: 3 });
  const samples = new TestSamples();
  const ref = samples.add([phrase.mix], SR, 'lead vocal');
  const { project, clipIds } = audioClipProject(ref, [{ start: 3840, length: 3840 * 3 }]);
  const s = createTestServices();
  s.fakeEngine.sampleAudio.set('lead vocal', { sampleRate: SR, channels: [phrase.mix], duration: phrase.mix.length / SR });
  s.history.load(project);
  cleanupState.setState({ clipId: null, rendering: null, problems: {}, clicks: {}, hearingRemoved: false });
  return { s, clipId: clipIds[0] as ClipId };
}
const run = (s: ReturnType<typeof createTestServices>, actions: AiAction[]) => applyAnswer(s, { message: 'ok', actions }, { previousBeat: null });
const clipOf = (s: ReturnType<typeof createTestServices>, id: ClipId) => s.doc.getState().project.playlist.clips[id] as AudioClip;

describe('the clean_vocal action and get_cleanup', () => {
  it('switches sections on and off in one undo step, and a part left out stays as it is', () => {
    const { s, clipId } = setup();
    const n0 = s.history.steps().done.length;
    const first = run(s, [{ op: 'clean_vocal', clip: clipId, noise_db: 14, breaths_db: 8, clicks: true }]);
    expect(first.warnings).toEqual([]);
    expect(s.history.steps().done.length).toBe(n0 + 1);
    expect(clipOf(s, clipId).cleanup).toEqual({
      noise: { amountDb: 14, sensitivity: 0.5 },
      breaths: { reduceDb: 8, sensitivity: 0.5 },
      clicks: { sensitivity: 0.5 },
    });
    const second = run(s, [{ op: 'clean_vocal', clip: clipId, breaths_db: 60, noise_sensitivity: 70 }]);
    expect(second.warnings).toEqual([]);
    expect(clipOf(s, clipId).cleanup).toMatchObject({ noise: { amountDb: 14, sensitivity: 0.7 }, breaths: { reduceDb: 60 }, clicks: { sensitivity: 0.5 } });
    const off = run(s, [{ op: 'clean_vocal', clip: clipId, noise_db: 0, breaths_db: 0, clicks: false }]);
    expect(off.warnings).toEqual([]);
    expect(clipOf(s, clipId).cleanup).toBeUndefined();
    s.history.undo();
    expect(clipOf(s, clipId).cleanup?.noise?.amountDb).toBe(14);
  });

  it('finds the clip by track and bar, takes a noise stretch and clears the whole cleanup', () => {
    const { s, clipId } = setup();
    const lane = Object.keys(s.doc.getState().project.playlist.lanes)[0];
    expect(lane).toBeDefined();
    const byBar = run(s, [{ op: 'clean_vocal', track: 1, bar: 2.5, noise_db: 10, noise_from: 0.1, noise_to: 0.6 }]);
    expect(byBar.warnings).toEqual([]);
    expect(clipOf(s, clipId).cleanup?.noise).toEqual({ amountDb: 10, sensitivity: 0.5, from: 0.1, to: 0.6 });
    const cleared = run(s, [{ op: 'clean_vocal', clip: clipId, clear: true }]);
    expect(cleared.warnings).toEqual([]);
    expect(clipOf(s, clipId).cleanup).toBeUndefined();
  });

  it('says what is wrong instead of guessing: nothing asked, a half stretch, a stretch too short, a clip that is not audio', () => {
    const { s, clipId } = setup();
    const messages = (actions: AiAction[]) => run(s, actions).warnings.join(' | ');
    expect(messages([{ op: 'clean_vocal', clip: clipId }])).toMatch(/say what to clean/);
    expect(messages([{ op: 'clean_vocal', clip: clipId, noise_db: 10, noise_from: 1 }])).toMatch(/go together/);
    expect(messages([{ op: 'clean_vocal', clip: clipId, noise_db: 10, noise_from: 1, noise_to: 1.05 }])).toMatch(/at least 0.1 seconds/);
    expect(messages([{ op: 'clean_vocal', clip: 'clip_nope', noise_db: 10 }])).not.toBe('');
    expect(clipOf(s, clipId).cleanup).toBeUndefined();
  });

  it('get_cleanup reads the state: nothing set, then what is on, the breaths found, whether the cleaned sound is ready and what is heard', () => {
    const { s, clipId } = setup();
    expect(runReadTool(s, 'get_cleanup', { clip: clipId })).toMatchObject({ state: 'none', hearing: 'cleaned sound' });
    run(s, [{ op: 'clean_vocal', clip: clipId, noise_db: 12, breaths_db: 10, clicks: true }]);
    const waiting = runReadTool(s, 'get_cleanup', { clip: clipId }) as Record<string, unknown>;
    expect(waiting).toMatchObject({
      state: 'being made',
      cleaned_audio: 'waiting to be made',
      noise: { reduction_db: 12, sensitivity_pct: 50 },
      breaths: { reduction_db: 10, found: expect.stringContaining('not looked for yet') },
      clicks: { sensitivity_pct: 50 },
    });
    expect(String(waiting.order)).toMatch(/cleanup, then pitch correction/);
    // The breaths a render found: numbered, with bars and seconds, and whether each is lowered.
    s.history.transact('Render found', (d) => {
      const clip = d.playlist.clips[clipId] as AudioClip;
      clip.cleanup!.breaths!.spans = [{ from: 1.2, to: 1.5 }, { from: 3, to: 3.3, off: true }];
    });
    const found = (runReadTool(s, 'get_cleanup', { clip: clipId }) as { breaths: { found: Array<Record<string, unknown>> } }).breaths.found;
    expect(found).toEqual([
      expect.objectContaining({ n: 1, start_s: 1.2, end_s: 1.5, lowered: true }),
      expect.objectContaining({ n: 2, start_s: 3, end_s: 3.3, lowered: false }),
    ]);
    s.editor.getState().setCleanupOriginal(clipId, true);
    expect(runReadTool(s, 'get_cleanup', { clip: clipId })).toMatchObject({ hearing: 'original recording' });
    expect(runReadTool(s, 'get_cleanup', { clip: 'clip_nope' })).toMatchObject({ error: expect.stringContaining('no audio clip') });
  });
});
