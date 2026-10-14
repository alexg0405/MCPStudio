/**
 * Audio clip playback through the real engine (offline renders): clip gain and fades, reverse,
 * pitch, and tempo follow by resampling or time-stretching (M15).
 */
import { describe, expect, it } from 'vitest';
import { clipEnvelopeAt } from '@core/audio/envelope';
import type { AudioClipChannel, Project } from '@core/model/types';
import { renderOffline } from '@engine/render-offline';
import {
  audioClipProject,
  autocorrelationPitch,
  clickTrain,
  onsetFrames,
  ramp,
  TestSamples,
  type AudioClipSpec,
} from '../helpers/audio';
import { automate, pt } from '../helpers/automation';
import { resolver } from '../helpers/fixtures';

const SR = 48000;
const LIMITER = Math.round(0.0013 * SR);
const BAR = 3840;

const stereo = (x: Float32Array) => [x, x.slice()];

async function render(project: Project, samples: TestSamples, bars: number) {
  const r = await renderOffline(project, {
    plugins: resolver(),
    samples: samples.provider,
    view: { mode: 'song', patternId: null, loop: null },
    bars,
    sampleRate: SR,
    tail: 0.2,
  });
  const start = Math.round(r.preRoll * SR) + LIMITER;
  return { out: r.buffer.getChannelData(0).subarray(start), right: r.buffer.getChannelData(1).subarray(start) };
}

function clipWith(
  signal: Float32Array,
  clip: AudioClipSpec,
  opts: { bpm?: number; channel?: Partial<AudioClipChannel> } = {},
) {
  const samples = new TestSamples();
  const ref = samples.add(stereo(signal), SR);
  return { samples, ...audioClipProject(ref, [clip], opts) };
}

describe('audio clips', () => {
  it('plays the clip gain and equal-power fades sample by sample', async () => {
    const sine = new Float32Array(3 * SR).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 1000 * i) / SR));
    const levels = { gain: 2, fadeIn: 0.25, fadeOut: 0.5 };
    const { samples, project } = clipWith(sine, { start: 0, length: BAR, ...levels });
    const { out, right } = await render(project, samples, 1);
    let err = 0;
    for (let i = 0; i < 2 * SR; i++) {
      const want = (sine[i] as number) * clipEnvelopeAt(levels, i / SR, 2);
      err = Math.max(err, Math.abs((out[i] as number) - want), Math.abs((right[i] as number) - want));
    }
    expect(err).toBeLessThan(0.002);
    // Silent once the clip has faded out.
    let after = 0;
    for (let i = 2 * SR; i < 2.1 * SR; i++) after = Math.max(after, Math.abs(out[i] as number));
    expect(after).toBeLessThan(1e-4);
  });

  it('plays a clip without fades at full level right up to its end', async () => {
    // Regression: the release at the clip end used to ramp from the start of the clip once its
    // note-off was scheduled, fading the last part of every clip.
    const dc = new Float32Array(2 * SR).fill(0.25);
    const { samples, project } = clipWith(dc, { start: 0, length: BAR });
    const { out } = await render(project, samples, 1);
    for (const t of [0.01, 0.5, 1, 1.5, 1.9, 1.995]) expect(out[Math.round(t * SR)]).toBeCloseTo(0.25, 4);
    expect(Math.abs(out[Math.round(2.005 * SR)] as number)).toBeLessThan(1e-4);
  });

  it('plays backwards when reversed, from its trim', async () => {
    const up = ramp(1, SR, 0.5);
    const whole = clipWith(up, { start: 0, length: BAR / 2 }, { channel: { reverse: true } });
    const { out } = await render(whole.project, whole.samples, 1);
    for (const t of [0.1, 0.5, 0.9]) expect(out[Math.round(t * SR)]).toBeCloseTo(0.5 * (1 - t), 3);
    // Trimmed 0.25 s into the reversed sound: it starts with the original's 0.75 s.
    const trimmed = clipWith(up, { start: 0, length: BAR / 4, offsetSec: 0.25 }, { channel: { reverse: true } });
    const t = await render(trimmed.project, trimmed.samples, 1);
    expect(t.out[Math.round(0.1 * SR)]).toBeCloseTo(0.5 * (0.75 - 0.1), 3);
  });

  it('resamples in time with a tempo change (one source beat per song beat)', async () => {
    // Clicks on every beat of a 120 BPM recording, 50 ms in.
    const clicks = clickTrain(0.5, 6, SR, 0.05);
    const base = clipWith(clicks, { start: 0, length: 3 * BAR }, { bpm: 120, channel: { stretch: 'resample', sourceBpm: 120 } });
    // 120 BPM in bar 1, 180 BPM from bar 2 (tempo clip range 60–180).
    const { project } = automate(
      base.project,
      { kind: 'tempo' },
      [pt(0, 0.5, { shape: 'hold' }), pt(BAR, 1, { shape: 'hold' })],
      [{ start: 0, length: 3 * BAR, lane: 1 }],
    );
    const { out } = await render(project, base.samples, 3);
    const songSec = (tick: number) => (tick < BAR ? tick / 1920 : 2 + (tick - BAR) / 2880);
    // Source second s is song tick s · 1920 (one 120 BPM beat per song beat).
    const want = onsetFrames(clicks, SR, 0.3, 0.1)
      .map((f) => songSec((f / SR) * 1920))
      .filter((s) => s < 2 + 2 * (4 / 3) - 0.05);
    const got = onsetFrames(out, SR, 0.3, 0.1).map((f) => f / SR);
    expect(got.length).toBe(want.length);
    got.forEach((g, i) => expect(Math.abs(g - want[i]!)).toBeLessThan(0.003));
  });

  it('time-stretches to the song tempo and keeps the pitch (the export waits for the stretch)', async () => {
    // 220 Hz for two seconds, then 330 Hz, recorded at 100 BPM; the song runs at 150 BPM.
    const tone = new Float32Array(4 * SR);
    for (let i = 0; i < tone.length; i++) {
      const hz = i < 2 * SR ? 220 : 330;
      tone[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / SR) + 0.1 * Math.sin((4 * Math.PI * hz * i) / SR);
    }
    const play = async (stretch: 'stretch' | 'resample') => {
      const c = clipWith(tone, { start: 0, length: 2 * BAR }, { bpm: 150, channel: { stretch, sourceBpm: 100 } });
      return (await render(c.project, c.samples, 2)).out;
    };
    const stretched = await play('stretch');
    // Source 2 s = 1.333 s of song: 220 Hz before, 330 Hz after, at their own pitch.
    expect(autocorrelationPitch(stretched, SR, Math.round(0.2 * SR), Math.round(1.1 * SR))).toBeCloseTo(220, 0);
    expect(autocorrelationPitch(stretched, SR, Math.round(1.5 * SR), Math.round(2.4 * SR))).toBeCloseTo(330, 0);
    // Resampling instead speeds the pitch up with the tempo (×1.5).
    const resampled = await play('resample');
    expect(autocorrelationPitch(resampled, SR, Math.round(0.2 * SR), Math.round(1.1 * SR))).toBeCloseTo(330, 0);
  });

  it('pitches by resampling when it keeps its own speed', async () => {
    const tone = new Float32Array(2 * SR).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR));
    const c = clipWith(tone, { start: 0, length: BAR }, { channel: { pitch: 1200 } });
    const { out } = await render(c.project, c.samples, 1);
    expect(autocorrelationPitch(out, SR, Math.round(0.1 * SR), Math.round(0.8 * SR))).toBeCloseTo(440, 0);
    // Twice as fast: the 2 s sound is over after 1 s.
    let tail = 0;
    for (let i = Math.round(1.01 * SR); i < 1.5 * SR; i++) tail = Math.max(tail, Math.abs(out[i] as number));
    expect(tail).toBeLessThan(1e-4);
  });
});
