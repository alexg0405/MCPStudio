import { describe, expect, it } from 'vitest';
import { constantTempo } from '../time/ppq';
import { steppedTempo } from '../time/tempo';
import { beatGrid, lastAtOrBefore, pulseAt, STRONG_PULSE, WEAK_PULSE } from './beats';
import { KEYFRAME_SECONDS, VIDEO_FORMAT_INFO, VIDEO_FORMATS, videoBitrate, videoDimensions } from './formats';
import { SpectrumAnalyzer, bandEdges } from './spectrum';
import {
  audioCenterFor,
  audioTimeUs,
  clockText,
  frameAtTime,
  frameCountFor,
  frameDurationUs,
  frameTimeUs,
  framesReady,
  isKeyframe,
  keyframeEvery,
} from './timing';

describe('frame timing', () => {
  it('covers all the audio with at least one frame', () => {
    expect(frameCountFor(10, 30)).toBe(300);
    expect(frameCountFor(10.0000000001, 30)).toBe(300);
    expect(frameCountFor(10.04, 30)).toBe(302);
    expect(frameCountFor(0.001, 60)).toBe(1);
    expect(frameCountFor(0, 30)).toBe(1);
    expect(frameCountFor(3600, 60)).toBe(216000);
  });

  it('rounds each frame time from the exact time, so the error never builds up', () => {
    expect(frameTimeUs(0, 30)).toBe(0);
    expect(frameTimeUs(1, 30)).toBe(33333);
    expect(frameTimeUs(2, 30)).toBe(66667);
    expect(frameTimeUs(3, 30)).toBe(100000);
    // One hour of 30 fps frames: exactly 3600 s, not a drift of microseconds per frame.
    expect(frameTimeUs(108000, 30)).toBe(3_600_000_000);
    expect(frameTimeUs(216000, 60)).toBe(3_600_000_000);
  });

  it('gives durations that add up to the next frame time', () => {
    let total = 0;
    for (let i = 0; i < 90; i++) {
      const d = frameDurationUs(i, 30);
      expect(d === 33333 || d === 33334).toBe(true);
      total += d;
    }
    expect(total).toBe(frameTimeUs(90, 30));
  });

  it('finds the frame showing at a time', () => {
    expect(frameAtTime(0, 30)).toBe(0);
    expect(frameAtTime(1 / 30, 30)).toBe(1);
    expect(frameAtTime(0.0333, 30)).toBe(0);
    expect(frameAtTime(2.5, 60)).toBe(150);
    expect(frameAtTime(-1, 30)).toBe(0);
  });

  it('puts a key frame about every two seconds', () => {
    expect(KEYFRAME_SECONDS).toBe(2);
    expect(keyframeEvery(30, 2)).toBe(60);
    expect(keyframeEvery(60, 2)).toBe(120);
    expect(isKeyframe(0, 30, 2)).toBe(true);
    expect(isKeyframe(59, 30, 2)).toBe(false);
    expect(isKeyframe(60, 30, 2)).toBe(true);
    expect(keyframeEvery(1, 0.1)).toBe(1);
  });

  it('maps a frame to the audio sample it looks at, and back to microseconds', () => {
    expect(audioCenterFor(30, 30, 48000)).toBe(48000);
    expect(audioCenterFor(1, 30, 48000)).toBe(1600);
    expect(audioCenterFor(1, 60, 44100)).toBe(735);
    expect(audioTimeUs(48000, 48000)).toBe(1_000_000);
    expect(audioTimeUs(1, 48000)).toBe(21);
  });

  it('knows how many frames can be drawn once some audio has arrived', () => {
    const look = 2048;
    expect(framesReady(0, 30, 48000, look)).toBe(0);
    expect(framesReady(2047, 30, 48000, look)).toBe(0);
    // Frame 0 needs 2048 samples after its centre (sample 0).
    expect(framesReady(2048, 30, 48000, look)).toBe(1);
    // Frame i needs 1600·i + 2048 samples.
    for (const frames of [3647, 3648, 48000, 100000]) {
      const n = framesReady(frames, 30, 48000, look);
      expect(audioCenterFor(n - 1, 30, 48000) + look).toBeLessThanOrEqual(frames);
      expect(audioCenterFor(n, 30, 48000) + look).toBeGreaterThan(frames);
    }
  });

  it('writes clock text as a player does', () => {
    expect(clockText(0)).toBe('0:00');
    expect(clockText(59.99)).toBe('0:59');
    expect(clockText(187)).toBe('3:07');
    expect(clockText(3729)).toBe('1:02:09');
  });
});

describe('formats', () => {
  it('keeps sizes even and the short side 1080', () => {
    expect(videoDimensions('1080p')).toEqual({ width: 1920, height: 1080 });
    expect(videoDimensions('vertical')).toEqual({ width: 1080, height: 1920 });
    expect(videoDimensions('square')).toEqual({ width: 1080, height: 1080 });
    const small = videoDimensions('1080p', 0.3333);
    expect(small.width % 2).toBe(0);
    expect(small.height % 2).toBe(0);
    expect(videoDimensions('vertical', 0.001)).toEqual({ width: 2, height: 2 });
  });

  it('scales bit rates by pixels and frame rate, with a floor', () => {
    for (const f of VIDEO_FORMATS) {
      const a = videoBitrate(f, 1920, 1080, 30);
      expect(a).toBe(VIDEO_FORMAT_INFO[f].videoBitrate[0]);
      expect(videoBitrate(f, 1080, 1920, 30)).toBe(a);
      expect(videoBitrate(f, 1080, 1080, 30)).toBeLessThan(a);
      expect(videoBitrate(f, 1920, 1080, 60)).toBe(VIDEO_FORMAT_INFO[f].videoBitrate[1]);
      expect(videoBitrate(f, 64, 36, 30)).toBe(400_000);
    }
  });

  it('names an audio and video codec for each format', () => {
    expect(VIDEO_FORMAT_INFO['mp4-h264'].videoCodec(30)).toBe('avc1.640028');
    expect(VIDEO_FORMAT_INFO['mp4-h264'].videoCodec(60)).toBe('avc1.64002a');
    expect(VIDEO_FORMAT_INFO['webm-vp9'].videoCodec(60)).toBe('vp09.00.41.08');
    expect(VIDEO_FORMAT_INFO['webm-av1'].audioCodec).toBe('opus');
    expect(VIDEO_FORMAT_INFO['mp4-h264'].audioCodec).toBe('mp4a.40.2');
  });
});

describe('beat grid', () => {
  const ts = { num: 4, den: 4 };

  it('lists a beat every quarter note, with bar starts marked', () => {
    // 120 bpm: a beat every 0.5 s. Two bars.
    const g = beatGrid(constantTempo(120), ts, 0, 3840 * 2);
    expect(g.times.length).toBe(8);
    expect([...g.times]).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect([...g.strong]).toEqual([1, 0, 0, 0, 1, 0, 0, 0]);
  });

  it('starts at the range, in seconds from its start', () => {
    // From bar 3 (tick 7680) for one bar, at 90 bpm.
    const g = beatGrid(constantTempo(90), ts, 7680, 7680 + 3840);
    expect(g.times.length).toBe(4);
    expect(g.times[0]).toBe(0);
    expect(g.times[1]).toBeCloseTo(60 / 90, 9);
    expect(g.strong[0]).toBe(1);
  });

  it('skips to the first beat when the range starts between beats', () => {
    const g = beatGrid(constantTempo(120), ts, 480, 3840);
    // Half a beat in: the next beat (tick 960) is 0.25 s away.
    expect(g.times[0]).toBeCloseTo(0.25, 9);
    expect(g.strong[0]).toBe(0);
    expect(g.times.length).toBe(3);
  });

  it('follows the time signature (6/8 beats are eighth notes)', () => {
    const g = beatGrid(constantTempo(120), { num: 6, den: 8 }, 0, 480 * 6);
    expect(g.times.length).toBe(6);
    expect([...g.strong]).toEqual([1, 0, 0, 0, 0, 0]);
  });

  it('follows tempo changes', () => {
    const tempo = steppedTempo([
      { tick: 0, bpm: 120 },
      { tick: 3840, bpm: 60 },
    ]);
    const g = beatGrid(tempo, ts, 0, 3840 * 2);
    // Bar 1: 4 beats of 0.5 s; bar 2: 4 beats of 1 s.
    expect(g.times[4]! - g.times[3]!).toBeCloseTo(0.5, 6);
    expect(g.times[5]! - g.times[4]!).toBeCloseTo(1, 6);
    expect(g.times[7]).toBeCloseTo(5, 6);
  });

  it('finds the latest beat at or before a time', () => {
    const t = Float64Array.of(0, 0.5, 1, 1.5);
    expect(lastAtOrBefore(t, -0.1)).toBe(-1);
    expect(lastAtOrBefore(t, 0)).toBe(0);
    expect(lastAtOrBefore(t, 0.49)).toBe(0);
    expect(lastAtOrBefore(t, 0.5)).toBe(1);
    expect(lastAtOrBefore(t, 99)).toBe(3);
    expect(lastAtOrBefore(new Float64Array(0), 1)).toBe(-1);
  });

  it('pulses on the beat, strongest on the bar, and dies away by the next one', () => {
    const g = beatGrid(constantTempo(120), ts, 0, 3840);
    expect(pulseAt(g, -0.01).amount).toBe(0);
    expect(pulseAt(g, 0).amount).toBe(STRONG_PULSE);
    expect(pulseAt(g, 0.5).amount).toBeCloseTo(WEAK_PULSE, 9);
    const mid = pulseAt(g, 0.25);
    expect(mid.beat).toBe(0);
    expect(mid.phase).toBeCloseTo(0.5, 9);
    expect(mid.amount).toBeLessThan(STRONG_PULSE);
    expect(mid.amount).toBeGreaterThan(0.1);
    // Just before the next beat it is nearly gone, then it jumps.
    expect(pulseAt(g, 0.4999).amount).toBeLessThan(0.06);
    // After the last beat it keeps fading.
    expect(pulseAt(g, 5).amount).toBeLessThan(1e-3);
  });

  it('puts the pulse at a beat in the frame that shows that moment, within one frame', () => {
    const g = beatGrid(constantTempo(128), ts, 0, 3840 * 2);
    const fps = 30;
    for (let k = 0; k < g.times.length; k++) {
      const beat = g.times[k]!;
      // The first frame at or after the beat.
      const frame = Math.ceil(beat * fps - 1e-9);
      const t = frame / fps;
      expect(t - beat).toBeLessThan(1 / fps);
      expect(pulseAt(g, t).beat).toBe(k);
      expect(pulseAt(g, t).amount).toBeGreaterThan(0.5 * (g.strong[k] ? STRONG_PULSE : WEAK_PULSE));
    }
  });
});

describe('spectrum bars', () => {
  const SR = 48000;
  const sine = (hz: number, amp: number, n = 4096) =>
    Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));

  it('has log-spaced band edges', () => {
    const e = bandEdges(4, 100, 1600);
    expect([...e].map((x) => Math.round(x))).toEqual([100, 200, 400, 800, 1600]);
  });

  it('lights the band a tone is in, and only around it', () => {
    const a = new SpectrumAnalyzer(SR, 48);
    const bars = a.process(sine(1000, 0.5), 0);
    const loudest = [...bars].indexOf(Math.max(...bars));
    const edges = bandEdges(48, 40, 16000);
    expect(edges[loudest]!).toBeLessThanOrEqual(1010);
    expect(edges[loudest + 1]!).toBeGreaterThanOrEqual(990);
    expect(bars[loudest]!).toBeGreaterThan(0.8);
    // Far-away bands are dark.
    expect(bars[2]!).toBeLessThan(0.05);
    expect(bars[44]!).toBeLessThan(0.05);
  });

  it('follows loudness: a quieter tone makes a shorter bar, silence none', () => {
    const peak = (amp: number) => {
      const a = new SpectrumAnalyzer(SR, 48);
      const bars = a.process(sine(440, amp), 0);
      return Math.max(...bars);
    };
    expect(peak(0.5)).toBeGreaterThan(peak(0.05));
    expect(peak(0.05)).toBeGreaterThan(peak(0.002));
    expect(peak(0)).toBe(0);
  });

  it('reads low tones that fall between two FFT bins', () => {
    const a = new SpectrumAnalyzer(SR, 64);
    const bars = a.process(sine(55, 0.5), 0);
    expect(Math.max(...bars.subarray(0, 12))).toBeGreaterThan(0.6);
  });

  it('rises at once and falls slowly', () => {
    const a = new SpectrumAnalyzer(SR, 48);
    const loud = Float32Array.from(a.process(sine(1000, 0.5), 1 / 30));
    const top = Math.max(...loud);
    const after = Math.max(...a.process(new Float32Array(4096), 1 / 30));
    expect(after).toBeLessThan(top);
    expect(after).toBeGreaterThan(top * 0.5);
    // And with no history it is exactly the new frame.
    a.reset();
    expect(Math.max(...a.process(new Float32Array(4096), 1 / 30))).toBe(0);
  });

  it('is deterministic: the same audio gives the same bars', () => {
    const x = sine(2000, 0.3);
    const a = Float32Array.from(new SpectrumAnalyzer(SR, 32).process(x, 1 / 60));
    const b = Float32Array.from(new SpectrumAnalyzer(SR, 32).process(x, 1 / 60));
    expect([...a]).toEqual([...b]);
  });

  it('reports a level that follows the loudness', () => {
    const a = new SpectrumAnalyzer(SR, 16);
    a.process(sine(300, 0.5), 0);
    const loud = a.level;
    a.reset();
    a.process(sine(300, 0.01), 0);
    expect(loud).toBeGreaterThan(a.level);
    expect(a.level).toBeGreaterThanOrEqual(0);
    expect(loud).toBeLessThanOrEqual(1);
  });
});
