import { describe, expect, it } from 'vitest';
import { hzToMidi, midiToHz, trackPitch } from './pitch';
import { noiseFloor, synthHum } from './test-signals';

function voicedMedian(track: { f0: Float32Array }): number {
  const v = Array.from(track.f0)
    .filter((f) => f > 0)
    .sort((a, b) => a - b);
  return v[v.length >> 1] ?? 0;
}

function sine(hz: number, sec: number, sr: number, amp = 0.5): Float32Array {
  return Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
}

describe('hzToMidi / midiToHz', () => {
  it('converts with A4 = 440 Hz = MIDI 69', () => {
    expect(hzToMidi(440)).toBe(69);
    expect(hzToMidi(261.6255653)).toBeCloseTo(60, 6);
    expect(hzToMidi(65.40639)).toBeCloseTo(36, 4);
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(57)).toBeCloseTo(220, 9);
    for (const m of [20.5, 36, 47.25, 81]) expect(hzToMidi(midiToHz(m))).toBeCloseTo(m, 9);
  });

  it('has no pitch for 0 Hz (unvoiced) or less', () => {
    expect(hzToMidi(0)).toBeNaN();
    expect(hzToMidi(-5)).toBeNaN();
  });
});

describe('trackPitch', () => {
  it.each([80, 98, 123.5, 155.6, 196, 246.9, 311.1, 400])('tracks a %s Hz hum within 0.3 semitone', (hz) => {
    const sr = 48000;
    const track = trackPitch(synthHum(sr, { hz, durationSec: 0.5 }), sr);
    const voiced = Array.from(track.f0).filter((f) => f > 0).length;
    expect(voiced).toBeGreaterThan(0.7 * track.f0.length);
    expect(Math.abs(hzToMidi(voicedMedian(track)) - hzToMidi(hz))).toBeLessThan(0.3);
  });

  it.each([
    [44100, 110],
    [16000, 220],
    [22050, 82.4],
    [96000, 146.8],
  ])('works at %i Hz (%s Hz hum)', (sr, hz) => {
    const track = trackPitch(synthHum(sr, { hz, durationSec: 0.4 }), sr);
    expect(Math.abs(hzToMidi(voicedMedian(track)) - hzToMidi(hz))).toBeLessThan(0.3);
  });

  it('reaches the ends of the default range (40 Hz and 1 kHz sines)', () => {
    const sr = 48000;
    for (const hz of [45, 1000]) {
      const track = trackPitch(sine(hz, 0.5, sr), sr);
      expect(Math.abs(hzToMidi(voicedMedian(track)) - hzToMidi(hz))).toBeLessThan(0.3);
    }
  });

  it('honours minHz / maxHz', () => {
    const sr = 48000;
    const track = trackPitch(sine(600, 0.4, sr), sr, { maxHz: 400 });
    // 600 Hz is out of range: no frame reports it.
    expect(Array.from(track.f0).some((f) => Math.abs(hzToMidi(f) - hzToMidi(600)) < 1)).toBe(false);
    const low = trackPitch(sine(60, 0.4, sr), sr, { minHz: 70 });
    expect(Array.from(low.f0).some((f) => Math.abs(hzToMidi(f) - hzToMidi(60)) < 1)).toBe(false);
  });

  it('follows a glide', () => {
    const sr = 44100;
    const track = trackPitch(synthHum(sr, { hz: 100, durationSec: 0.6, glideToHz: 200 }), sr);
    const at = (t: number) => track.f0[Math.round((t * sr) / Math.round(sr * 0.005))] as number;
    expect(Math.abs(hzToMidi(at(0.15)) - (hzToMidi(100) + 12 * (0.15 / 0.6)))).toBeLessThan(0.5);
    expect(Math.abs(hzToMidi(at(0.45)) - (hzToMidi(100) + 12 * (0.45 / 0.6)))).toBeLessThan(0.5);
  });

  it('reports silence and noise as unvoiced', () => {
    const sr = 48000;
    const silent = trackPitch(new Float32Array(sr / 2), sr);
    expect(Array.from(silent.f0).every((f) => f === 0)).toBe(true);
    expect(Array.from(silent.confidence).every((c) => c === 0)).toBe(true);

    const noise = trackPitch(noiseFloor(sr, 1, -20), sr);
    const voiced = Array.from(noise.f0).filter((f) => f > 0).length;
    expect(voiced).toBeLessThan(0.1 * noise.f0.length);
    const conf = Array.from(noise.confidence).sort((a, b) => a - b);
    expect(conf[conf.length >> 1]).toBeLessThan(0.6);
  });

  it('is confident on clean tones', () => {
    const sr = 48000;
    const track = trackPitch(synthHum(sr, { hz: 130.8, durationSec: 0.5 }), sr);
    const mid = track.confidence.subarray(10, track.confidence.length - 15);
    expect(Math.min(...mid)).toBeGreaterThan(0.9);
  });

  it('lays frames out every hop, from t = 0', () => {
    const sr = 8000;
    const x = sine(200, 0.3, sr);
    const t = trackPitch(x, sr, { hop: 80, window: 400 });
    expect(t.times.length).toBe(Math.floor((x.length - 1) / 80) + 1);
    expect(t.f0.length).toBe(t.times.length);
    expect(t.confidence.length).toBe(t.times.length);
    expect(t.times[0]).toBe(0);
    expect(t.times[3]).toBeCloseTo(0.03, 6);
    expect(Math.abs(hzToMidi(voicedMedian(t)) - hzToMidi(200))).toBeLessThan(0.3);
  });

  it('handles empty, tiny and non-finite input', () => {
    expect(trackPitch(new Float32Array(0), 48000).times.length).toBe(0);
    expect(trackPitch(new Float32Array(1), 48000).times.length).toBe(1);
    expect(trackPitch(new Float32Array(37).fill(0.3), 48000).f0.length).toBe(1);
    expect(trackPitch(new Float32Array(100), 0).times.length).toBe(0);
    const bad = sine(150, 0.3, 16000);
    bad[100] = NaN;
    bad[2000] = Infinity;
    const t = trackPitch(bad, 16000);
    expect(Array.from(t.f0).every(Number.isFinite)).toBe(true);
    expect(Math.abs(hzToMidi(voicedMedian(t)) - hzToMidi(150))).toBeLessThan(0.3);
  });
});
