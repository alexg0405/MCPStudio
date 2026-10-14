import { describe, expect, it } from 'vitest';
import { constantTempo } from '../time/ppq';
import { steppedTempo } from '../time/tempo';
import {
  clipEnvelopeAt,
  envelopeBreakpoints,
  fadeShape,
  formatDb,
  formatSeconds,
  normalizeGain,
} from './envelope';
import {
  clipSourceRange,
  mirroredOffset,
  naturalLength,
  playbackKey,
  playbackMode,
  sourceRateAt,
  sourceSecondsAt,
  stretchScale,
  tickAtSourceSeconds,
} from './playback';

const BAR = 3840;

describe('audio clip playback', () => {
  it('plays at its own speed unless it follows the tempo with a source BPM', () => {
    expect(playbackMode({}).follow).toBe('off');
    expect(playbackMode({ stretch: 'stretch' }).follow).toBe('off'); // no source BPM
    const m = playbackMode({ stretch: 'resample', sourceBpm: 100, pitch: 1200 });
    expect(m).toMatchObject({ follow: 'resample', sourceBpm: 100, pitch: 2, reverse: false });
    expect(playbackKey({ sampleId: 's' as never, pitch: 0 })).toBe(playbackKey({ sampleId: 's' as never }));
    expect(playbackKey({ sampleId: 's' as never, reverse: true })).not.toBe(playbackKey({ sampleId: 's' as never }));
  });

  it('maps song ticks to sample seconds in each mode, and back', () => {
    const tempo = steppedTempo([
      { tick: 0, bpm: 120 },
      { tick: 2 * BAR, bpm: 180 },
    ]);
    const clip = { start: BAR, offsetSec: 0.5 };
    const off = playbackMode({ pitch: 1200 });
    // Own speed (×2 for an octave up): 1 bar at 120 BPM = 2 s of song → 4 s of sample.
    expect(sourceSecondsAt(clip, off, tempo, 2 * BAR)).toBeCloseTo(4.5, 9);
    // Bar 3 runs at 180 BPM: 4/3 s of song → 8/3 s of sample.
    expect(sourceSecondsAt(clip, off, tempo, 3 * BAR)).toBeCloseTo(4.5 + 8 / 3, 9);
    const resample = playbackMode({ stretch: 'resample', sourceBpm: 120 });
    // Locked to beats: every bar is 2 s of a 120 BPM sample, whatever the song tempo.
    expect(sourceSecondsAt(clip, resample, tempo, 3 * BAR)).toBeCloseTo(4.5, 9);
    expect(sourceRateAt(resample, tempo, 2.5 * BAR)).toBeCloseTo(1.5, 9);
    const stretch = playbackMode({ stretch: 'stretch', sourceBpm: 90, pitch: 700 });
    expect(sourceSecondsAt(clip, stretch, tempo, 2 * BAR)).toBeCloseTo(0.5 + (4 * 60) / 90, 9);
    for (const m of [off, resample, stretch])
      for (const tick of [BAR, 1.3 * BAR, 2 * BAR, 2.7 * BAR])
        expect(tickAtSourceSeconds(clip, m, tempo, sourceSecondsAt(clip, m, tempo, tick))).toBeCloseTo(tick, 6);
  });

  it('measures natural lengths, source ranges and the mirrored trim for reverse', () => {
    const tempo = constantTempo(120); // 1920 ticks per second
    const mode = playbackMode({});
    expect(naturalLength({ start: 0, offsetSec: 1 }, mode, tempo, 3)).toBe(3840);
    const clip = { start: 0, offsetSec: 1, length: 1920 };
    expect(clipSourceRange(clip, mode, tempo, 3)).toEqual({ from: 1, to: 2 });
    // The clip covers 1–2 s of a 3 s sound; reversed, that audio sits at 1–2 s too.
    expect(mirroredOffset(clip, mode, tempo, 3)).toBeCloseTo(1, 9);
    expect(mirroredOffset({ ...clip, offsetSec: 0 }, mode, tempo, 3)).toBeCloseTo(2, 9);
  });

  it('picks one stretch scale per tempo (pitch included)', () => {
    const tempo = constantTempo(150);
    expect(stretchScale(playbackMode({ stretch: 'stretch', sourceBpm: 100 }), tempo, 0)).toBeCloseTo(2 / 3, 5);
    expect(stretchScale(playbackMode({ stretch: 'stretch', sourceBpm: 150, pitch: 1200 }), tempo, 0)).toBe(2);
    expect(stretchScale(playbackMode({ stretch: 'resample', sourceBpm: 100 }), tempo, 0)).toBe(1);
  });
});

describe('audio clip envelope', () => {
  it('applies the clip gain and equal-power fades', () => {
    const c = { gain: 2, fadeIn: 0.1, fadeOut: 0.2 };
    expect(clipEnvelopeAt(c, 0, 1)).toBe(0);
    expect(clipEnvelopeAt(c, 0.05, 1)).toBeCloseTo(2 * Math.SQRT1_2, 9); // −3 dB halfway
    expect(clipEnvelopeAt(c, 0.5, 1)).toBe(2);
    expect(clipEnvelopeAt(c, 0.9, 1)).toBeCloseTo(2 * Math.SQRT1_2, 9);
    expect(clipEnvelopeAt(c, 1, 1)).toBe(0);
    expect(clipEnvelopeAt({}, 0.3, 1)).toBe(1);
    expect(clipEnvelopeAt({}, 1.5, 1)).toBe(0);
    // Overlapping fades multiply: smooth, below the gain.
    const short = { fadeIn: 0.8, fadeOut: 0.8 };
    expect(clipEnvelopeAt(short, 0.5, 1)).toBeCloseTo(fadeShape(0.5 / 0.8) ** 2, 9);
  });

  it('breaks the curve into ramps that stay within 0.2 % of it', () => {
    const c = { gain: 1.5, fadeIn: 0.25, fadeOut: 0.5 };
    const points = envelopeBreakpoints(c, 2);
    expect(points[0]).toEqual([0, 0]);
    expect(points[points.length - 1]![0]).toBe(2);
    let worst = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const [x0, v0] = points[i]!;
      const [x1, v1] = points[i + 1]!;
      for (let k = 1; k < 8; k++) {
        const x = x0 + ((x1 - x0) * k) / 8;
        const lin = v0 + ((v1 - v0) * k) / 8;
        worst = Math.max(worst, Math.abs(lin - clipEnvelopeAt(c, x, 2)) / 1.5);
      }
    }
    expect(worst).toBeLessThan(0.002);
    // Starting inside the fade-in: the first point is where playback starts.
    const late = envelopeBreakpoints(c, 2, 0.1);
    expect(late[0]![0]).toBe(0.1);
    expect(late[0]![1]).toBeCloseTo(clipEnvelopeAt(c, 0.1, 2), 12);
  });

  it('normalizes to −0.3 dBFS and formats levels and times', () => {
    expect(normalizeGain(0.5)).toBeCloseTo(10 ** (-0.3 / 20) / 0.5, 12);
    expect(normalizeGain(0.01)).toBe(4);
    expect(normalizeGain(0)).toBe(1);
    expect(formatDb(1)).toBe('0.0 dB');
    expect(formatDb(2)).toBe('+6.0 dB');
    expect(formatDb(0.5)).toBe('−6.0 dB');
    expect(formatDb(0)).toBe('−inf dB');
    expect(formatSeconds(0.012)).toBe('12 ms');
    expect(formatSeconds(1.25)).toBe('1.25 s');
  });
});
