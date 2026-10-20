/**
 * An aligned clip plays the aligned render, not the channel's own sample, in the real engine (offline render: what export
 * uses); the A/B filter (`unalignedSound`) plays the recording; and with a pitch edit on top the pitch render wins over the
 * alignment's. The alignment itself (WSOLA warp, PSOLA) is checked in core/audio/align; here it is the engine's choice of sound.
 */
import { describe, expect, it } from 'vitest';
import { alignToGuide } from '@core/audio/align';
import { alignedSampleId } from '@core/audio/align/edit';
import type { AudioClip, ClipId, Project } from '@core/model/types';
import { unalignedSound } from '@core/query/hear';
import { renderOffline } from '@engine/render-offline';
import { makeScenario } from '../helpers/align-scenario';
import { audioClipProject, TestSamples } from '../helpers/audio';
import { resolver } from '../helpers/fixtures';
import { attackTime } from '../helpers/syllables';

const SR = 48000;
const BAR = 3840;
/** The limiter's look-ahead, in frames: the render is delayed by it. */
const LIMITER = Math.round(0.0013 * SR);

async function render(project: Project, samples: TestSamples): Promise<Float32Array> {
  const r = await renderOffline(project, {
    plugins: resolver(),
    samples: samples.provider,
    view: { mode: 'song', patternId: null, loop: null },
    bars: 3,
    sampleRate: SR,
    tail: 0.2,
  });
  return r.buffer.getChannelData(0).subarray(Math.round(r.preRoll * SR) + LIMITER);
}

describe('aligned clips in the engine', () => {
  it('play the aligned render, the recording when the A/B filter is on, and fall back when the render is missing', async () => {
    const scenario = makeScenario({ sampleRate: SR, seed: 3, syllables: 6, jitterSec: 0.08 });
    const audible = { fromSec: 0, toSec: scenario.seconds };
    const aligned = alignToGuide({
      channels: [scenario.double],
      sampleRate: SR,
      audible,
      guide: { mono: scenario.lead, sampleRate: SR, audible },
      tightness: 100,
      pitch: 0,
    }).channels[0] as Float32Array;

    const samples = new TestSamples();
    const original = samples.add([scenario.double, scenario.double.slice()], SR, 'double');
    const alignedRef = samples.add([aligned, aligned.slice()], SR, 'double (aligned)');
    const { project, clipIds } = audioClipProject(original, [{ start: 0, length: BAR * 3 }]);
    const clipId = clipIds[0] as ClipId;
    const withAlign = (renderedSampleId: string | null): Project => ({
      ...project,
      samples: renderedSampleId ? { ...project.samples, [alignedRef.id]: alignedRef } : project.samples,
      playlist: {
        ...project.playlist,
        clips: {
          ...project.playlist.clips,
          [clipId]: {
            ...(project.playlist.clips[clipId] as AudioClip),
            align: { mode: 'guide', guide: 'clip_lead' as ClipId, tightness: 100, ...(renderedSampleId ? { renderedSampleId: renderedSampleId as never, renderedFor: 'sig' } : {}) },
          },
        },
      },
    });

    /** How far (ms) the clip's syllable starts are from the lead's in what the engine renders. */
    const worstOffMs = async (p: Project) => {
      const out = await render(p, samples);
      return Math.max(...scenario.leadStarts.map((t) => Math.abs((attackTime(out, SR, t, 0.12) - attackTime(scenario.lead, SR, t, 0.12)) * 1000)));
    };
    // With the render: every syllable on the lead's within the render's own accuracy.
    expect(await worstOffMs(withAlign(alignedRef.id))).toBeLessThan(10);
    // The recording as recorded: it is off by tens of milliseconds.
    expect(await worstOffMs(withAlign(null))).toBeGreaterThan(30);
    // The A/B filter plays the recording although the render is there.
    const filtered = unalignedSound(withAlign(alignedRef.id), [clipId]);
    expect(((filtered.playlist.clips[clipId] as AudioClip).align?.renderedSampleId)).toBeUndefined();
    expect(await worstOffMs(filtered)).toBeGreaterThan(30);
    // The render's sample is not in the project (damaged file): the clip plays its recording, not silence.
    const missing = withAlign(alignedRef.id);
    expect(await worstOffMs({ ...missing, samples: { [original.id]: original } })).toBeGreaterThan(30);
  }, 180_000);

  it('start the Pitch editor from the aligned sound, and the pitch render goes before the alignment render', () => {
    const clip = {
      align: { mode: 'grid', tightness: 70, renderedSampleId: 'smp_aligned' },
      pitchEdit: { notes: [], renderedSampleId: 'smp_tuned' },
    } as unknown as AudioClip;
    expect(alignedSampleId({ sampleId: 'smp_own' as never }, clip)).toBe('smp_aligned');
  });
});
