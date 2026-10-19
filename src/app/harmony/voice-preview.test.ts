import { describe, expect, it } from 'vitest';
import { audioClipProject, TestSamples } from '../../../test/helpers/audio';
import { sing } from '../../../test/helpers/sung';
import { previewMix } from '@core/harmony/voices';
import type { ClipId } from '@core/model/types';
import { createTestServices } from '../testing';
import { buildPreview } from './voice-preview';
import { defaultVoice } from './voice-spec';

const SR = 48000;

describe('previewMix', () => {
  it('puts the voices at their level and pan on top of the lead, and turns both down together when the stack is too loud', () => {
    const lead = [Float32Array.from([0.1, 0.1, 0.1, 0.1])];
    const voice = { channels: [Float32Array.from([0.1, 0.1, 0.1, 0.1])], levelDb: -6.0206, pan: -1 };
    const quiet = previewMix(lead, [voice]);
    // Hard left: the voice is half as loud (−6 dB) in the left ear only.
    expect(quiet.withHarmonies[0][0]).toBeCloseTo(0.1 + 0.1 * 0.5 * Math.SQRT2 * Math.cos(0), 5);
    expect(quiet.withHarmonies[1][0]).toBeCloseTo(0.1, 5);
    expect(quiet.leadOnly[0][0]).toBeCloseTo(0.1, 6);
    const loud = previewMix([Float32Array.from([0.9, -0.9])], [{ channels: [Float32Array.from([0.9, -0.9])], levelDb: 0, pan: 0 }]);
    const peak = Math.max(...loud.withHarmonies[0].map(Math.abs));
    expect(peak).toBeLessThanOrEqual(0.95 + 1e-6);
    // The same scale on the lead alone, so A/B changes only the harmonies.
    // The stack peaks at 1.8 (the lead and a centred voice), so both go down by 0.95 / 1.8.
    expect(Math.abs(loud.leadOnly[0][0] as number)).toBeCloseTo(0.9 * (0.95 / 1.8), 5);
  });
});

describe('buildPreview', () => {
  it('renders the lead alone and the lead with its voices as two WAV files of the same length', async () => {
    const x = sing([{ from: 0.1, to: 0.9, midi: 69 }, { from: 1.1, to: 1.9, midi: 72 }], SR, 2.2);
    const samples = new TestSamples();
    const ref = samples.add([x], SR, 'lead vocal');
    const { project, clipIds } = audioClipProject(ref, [{ start: 0, length: 3840 * 2 }]);
    const s = createTestServices();
    s.fakeEngine.sampleAudio.set('lead vocal', { sampleRate: SR, channels: [x], duration: x.length / SR });
    s.history.load({ ...project, transport: { ...project.transport, key: { root: 9, scale: 'minor' } } });
    const preview = await buildPreview(s, clipIds[0] as ClipId, {
      voices: [defaultVoice({ kind: 'interval', steps: 2 }, 0, 1)],
      humanize: { timingMs: 10, driftCents: 5, vibrato: 0.2 },
      seed: 3,
    });
    expect(preview.seconds).toBeCloseTo(2.2, 1);
    expect(preview.leadOnly.length).toBe(preview.withHarmonies.length);
    expect(String.fromCharCode(...preview.leadOnly.slice(0, 4))).toBe('RIFF');
    expect(Buffer.from(preview.leadOnly).equals(Buffer.from(preview.withHarmonies))).toBe(false);
  });
});
