/**
 * A clip with a pitch correction plays the corrected render, not the channel's own sample, in the
 * real engine (offline render: what export uses) and in the realtime engine's clip player; the
 * original stays in the project. The render itself (TD-PSOLA) is checked in core/audio.
 */
import { describe, expect, it } from 'vitest';
import { analyzePitch } from '@core/voice/pitch-notes';
import { midiToHz } from '@core/voice/pitch';
import { pitchEditFrom, renderPitchEdit, snapToKey, editSignature } from '@core/audio/pitch-edit';
import type { AudioClip, Project } from '@core/model/types';
import { renderOffline } from '@engine/render-offline';
import { audioClipProject, TestSamples } from '../helpers/audio';
import { resolver } from '../helpers/fixtures';
import { centsBetween, peakFrequency, sing } from '../helpers/sung';

const SR = 48000;
const BAR = 3840;
const MAJOR = [true, false, true, false, true, true, false, true, false, true, false, true];
const LIMITER = Math.round(0.0013 * SR);

async function render(project: Project, samples: TestSamples) {
  const r = await renderOffline(project, {
    plugins: resolver(),
    samples: samples.provider,
    view: { mode: 'song', patternId: null, loop: null },
    bars: 1,
    sampleRate: SR,
    tail: 0.2,
  });
  const start = Math.round(r.preRoll * SR) + LIMITER;
  return r.buffer.getChannelData(0).subarray(start);
}

describe('pitch-corrected clips', () => {
  it('play the render in an offline render, the original without it, and fall back when it is missing', async () => {
    // A note sung 30 cents sharp of C4.
    const voice = sing([{ from: 0.1, to: 1.7, midi: 60.3 }], SR, 1.9);
    const notes = analyzePitch(voice, SR).notes;
    const edit = snapToKey(pitchEditFrom(notes), MAJOR);
    const [fixed] = renderPitchEdit({ channels: [voice], sampleRate: SR, start: 0, edit });

    const samples = new TestSamples();
    const original = samples.add([voice, voice.slice()], SR, 'vocal');
    const corrected = samples.add([fixed as Float32Array, (fixed as Float32Array).slice()], SR, 'vocal (pitch corrected)');
    const { project, clipIds } = audioClipProject(original, [{ start: 0, length: BAR }]);
    const clipId = clipIds[0]!;
    const withEdit = (renderedSampleId: string | null): Project => ({
      ...project,
      samples: renderedSampleId ? { ...project.samples, [corrected.id]: corrected } : project.samples,
      playlist: {
        ...project.playlist,
        clips: {
          ...project.playlist.clips,
          [clipId]: {
            ...(project.playlist.clips[clipId] as AudioClip),
            pitchEdit: {
              ...edit,
              ...(renderedSampleId ? { renderedSampleId: renderedSampleId as never, renderedFor: editSignature(edit) } : {}),
            },
          },
        },
      },
    });

    const span = [Math.round(0.5 * SR), Math.round(1.5 * SR)] as const;
    const hearsAt = async (p: Project) => {
      const out = await render(p, samples);
      const want = midiToHz(60);
      return centsBetween(peakFrequency(out, SR, 3 * want, span[0], span[1], 24), 3 * want);
    };
    // With the render: C4 within a couple of cents (the limiter and 32-bit decode add nothing).
    expect(Math.abs(await hearsAt(withEdit(corrected.id)))).toBeLessThan(2);
    // Without a render (an edit not rendered yet, or nothing): the original, 30 cents sharp.
    expect(Math.abs((await hearsAt(withEdit(null))) - 30)).toBeLessThan(2);
    // The render's sample is not in the project (damaged file): the clip plays the original, not silence.
    const missing = withEdit(corrected.id);
    const trimmed: Project = { ...missing, samples: { [original.id]: original } };
    expect(Math.abs((await hearsAt(trimmed)) - 30)).toBeLessThan(2);
  }, 120_000);
});
