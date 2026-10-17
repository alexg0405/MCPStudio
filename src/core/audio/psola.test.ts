import { describe, expect, it } from 'vitest';
import { centsBetween, formantPeak, peakFrequency, sing } from '../../../test/helpers/voice';
import { midiToHz, trackPitch } from '../voice/pitch';
import { psolaShift, type PsolaTrack } from './psola';

const SR = 48000;
const HOP = 240;

/** A track with a constant f0 and shift over `seconds`. */
function flatTrack(f0: number, cents: number, seconds: number): PsolaTrack {
  const frames = Math.floor((seconds * SR) / HOP) + 1;
  return { f0: new Float32Array(frames).fill(f0), shift: new Float32Array(frames).fill(cents), hop: HOP, t0: 0 };
}

const voice = (midi: number, seconds = 1.6) => sing([{ from: 0, to: seconds, midi }], SR, seconds);

describe('psolaShift', () => {
  it('moves the pitch by the asked ratio, within a cent, up and down', () => {
    const f0 = midiToHz(50.4); // ~ 135 Hz, slightly off a note
    const x = voice(50.4);
    for (const cents of [-1200, -700, -230, -35, 17, 100, 333, 500, 1200]) {
      const [y] = psolaShift([x], SR, flatTrack(f0, cents, 1.6));
      const want = f0 * Math.pow(2, cents / 1200);
      // The 4th harmonic's frequency (more precise than the fundamental), over the steady middle.
      const got = peakFrequency(y as Float32Array, SR, 4 * want, Math.round(0.5 * SR), Math.round(1.3 * SR), 4);
      const err = centsBetween(got, 4 * want);
      expect(Math.abs(err), `${cents} cents`).toBeLessThan(1);
    }
  });

  it('keeps the formants: the envelope peak moves less than 5 % at ±5 semitones', () => {
    const f0 = midiToHz(48); // 130.8 Hz
    const x = voice(48);
    const span = [Math.round(0.5 * SR), Math.round(1.3 * SR)] as const;
    const before = formantPeak(x, SR, f0, span[0], span[1]);
    expect(Math.abs(before / 900 - 1)).toBeLessThan(0.05);
    for (const cents of [-500, 500]) {
      const [y] = psolaShift([x], SR, flatTrack(f0, cents, 1.6));
      const shifted = f0 * Math.pow(2, cents / 1200);
      const after = formantPeak(y as Float32Array, SR, shifted, span[0], span[1]);
      expect(Math.abs(after / before - 1), `${cents} cents: ${before.toFixed(0)} → ${after.toFixed(0)} Hz`).toBeLessThan(0.05);
    }
  });

  it('makes no clicks: no sample step beyond what the voice has, no overs', () => {
    const f0 = midiToHz(52);
    const x = voice(52, 1.2);
    const stepOf = (a: Float32Array, from: number, to: number) => {
      let worst = 0;
      for (let i = from + 1; i < to; i++) worst = Math.max(worst, Math.abs((a[i] as number) - (a[i - 1] as number)));
      return worst;
    };
    const base = stepOf(x, 0, x.length);
    for (const cents of [-300, 47, 200, 700]) {
      const [y] = psolaShift([x], SR, flatTrack(f0, cents, 1.2));
      expect(stepOf(y as Float32Array, 0, y!.length), `${cents} cents`).toBeLessThan(base * 1.6);
      expect(Math.max(...Array.from(y as Float32Array, Math.abs))).toBeLessThan(1);
    }
  });

  it('a gliding shift moves smoothly (no jump in pitch or level)', () => {
    const f0 = midiToHz(55);
    const x = voice(55, 1.5);
    const frames = Math.floor((1.5 * SR) / HOP) + 1;
    const shift = new Float32Array(frames);
    for (let i = 0; i < frames; i++) shift[i] = Math.max(0, Math.min(400, ((i * HOP) / SR - 0.4) * 800));
    const [y] = psolaShift([x], SR, { f0: new Float32Array(frames).fill(f0), shift, hop: HOP, t0: 0 });
    const out = y as Float32Array;
    // RMS per 20 ms stays level.
    const rms: number[] = [];
    for (let a = Math.round(0.1 * SR); a + 960 < Math.round(1.4 * SR); a += 960) {
      let s = 0;
      for (let i = a; i < a + 960; i++) s += (out[i] as number) ** 2;
      rms.push(Math.sqrt(s / 960));
    }
    expect(Math.max(...rms) / Math.min(...rms)).toBeLessThan(1.25);
  });

  it('zero shift gives the input back (within rounding), also through a tracked voice', () => {
    const x = voice(53, 1);
    const track = trackPitch(x, SR, { minHz: 70, maxHz: 1000 });
    const shift = new Float32Array(track.f0.length); // all zero: nothing to do
    const [y] = psolaShift([x], SR, { f0: track.f0, shift, hop: Math.round(0.005 * SR), t0: 0 });
    expect(Array.from(y as Float32Array)).toEqual(Array.from(x));
    // A shift that is zero over a stretch but not elsewhere leaves that stretch unchanged.
    const some = new Float32Array(track.f0.length);
    for (let i = 160; i < 190; i++) some[i] = 200;
    const [z] = psolaShift([x], SR, { f0: track.f0, shift: some, hop: Math.round(0.005 * SR), t0: 0 });
    let worst = 0;
    for (let i = 0; i < Math.round(0.6 * SR); i++) worst = Math.max(worst, Math.abs((z![i] as number) - (x[i] as number)));
    expect(worst).toBeLessThan(1e-6);
  });

  it('follows a YIN pitch track on a sung line and lands on the new pitch', () => {
    const x = voice(57.3, 1.6);
    const hop = Math.round(0.005 * SR);
    const track = trackPitch(x, SR, { minHz: 70, maxHz: 1000, hop });
    const shift = new Float32Array(track.f0.length).fill(-30); // pull 30 cents flat
    const [y] = psolaShift([x], SR, { f0: track.f0, shift, hop, t0: 0 });
    const want = midiToHz(57.3) * Math.pow(2, -30 / 1200);
    const got = peakFrequency(y as Float32Array, SR, 3 * want, Math.round(0.5 * SR), Math.round(1.3 * SR), 4);
    expect(Math.abs(centsBetween(got, 3 * want))).toBeLessThan(1);
  });

  it('shifts both channels together and leaves the input alone', () => {
    const f0 = midiToHz(50);
    const l = voice(50, 1);
    const r = Float32Array.from(l, (v) => v * 0.5);
    const copy = Float32Array.from(l);
    const [a, b] = psolaShift([l, r], SR, flatTrack(f0, 300, 1));
    expect(Array.from(l)).toEqual(Array.from(copy));
    for (let i = 20000; i < 30000; i += 97) expect((b as Float32Array)[i]).toBeCloseTo(0.5 * (a as Float32Array)[i]!, 6);
  });

  it('is deterministic', () => {
    const x = voice(50, 0.8);
    const track = flatTrack(midiToHz(50), 123, 0.8);
    const [a] = psolaShift([x], SR, track);
    const [b] = psolaShift([x], SR, track);
    expect(Array.from(a as Float32Array)).toEqual(Array.from(b as Float32Array));
  });
});
