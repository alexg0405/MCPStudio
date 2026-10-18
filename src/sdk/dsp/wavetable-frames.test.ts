import { describe, expect, it } from 'vitest';
import {
  bandLimit,
  boxResample,
  buildFrameBank,
  decodeFrame,
  decodeWav,
  drawStroke,
  EMPTY_TABLE_STATE,
  encodeFrame,
  encodeWav,
  frameAt,
  frameFromHarmonics,
  frameFromWave,
  framesBetween,
  framesFromCycles,
  framesFromSlices,
  framesOfState,
  frameToWave,
  FRAME_HARMONICS,
  FRAME_POINTS,
  harmonicAmps,
  invertFrame,
  isSilent,
  MAX_FRAMES,
  morphFrames,
  newFrame,
  normalizeFrame,
  peakOf,
  readUserTableState,
  removeDc,
  reverseFrame,
  setHarmonic,
  smoothFrame,
  thin,
  userTableState,
} from './wavetable-frames';
import { WavetableBank, WT_LEVELS } from './wavetable';

/** A cycle of n samples of a function of the phase. */
const cycle = (n: number, f: (t: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i / n));
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
  return m;
};

describe('frames: time and frequency views', () => {
  it('a wave goes through harmonics and back unchanged (power-of-two cycles, DC included)', () => {
    const wave = cycle(1024, (t) => 0.2 + 0.5 * Math.sin(2 * Math.PI * 3 * t) + 0.3 * Math.cos(2 * Math.PI * 17 * t + 1));
    const f = frameFromWave(wave);
    expect(f.cos[0]).toBeCloseTo(0.2, 6);
    expect(Math.hypot(f.sin[3] as number, f.cos[3] as number)).toBeCloseTo(0.5, 6);
    expect(maxDiff(frameToWave(f), wave)).toBeLessThan(1e-5);
  });

  it('reads cycles of any length exactly (a 600-sample cycle of a sine is a sine)', () => {
    const f = frameFromWave(cycle(600, (t) => Math.sin(2 * Math.PI * 5 * t)));
    expect(f.sin[5]).toBeCloseTo(1, 6);
    expect(f.cos[5]).toBeCloseTo(0, 6);
    for (let k = 1; k < 100; k++) if (k !== 5) expect(Math.hypot(f.sin[k] as number, f.cos[k] as number)).toBeLessThan(1e-6);
  });

  it('a long cycle is averaged down first, short ones keep only the harmonics they can hold', () => {
    expect(boxResample([1, 1, 3, 3], 2)).toEqual(Float32Array.from([1, 3]));
    const long = frameFromWave(cycle(20000, (t) => Math.sin(2 * Math.PI * 2 * t)));
    expect(long.sin[2]).toBeCloseTo(1, 3);
    const short = frameFromWave(cycle(64, (t) => Math.sin(2 * Math.PI * 3 * t)));
    expect(short.sin[3]).toBeCloseTo(1, 6);
    expect(harmonicAmps(short, FRAME_HARMONICS).slice(31).every((x) => x === 0)).toBe(true);
  });

  it('harmonicAmps gives the strength of each harmonic whatever its phase', () => {
    const f = frameFromWave(cycle(1024, (t) => 0.5 * Math.cos(2 * Math.PI * 2 * t + 0.7) + 0.25 * Math.sin(2 * Math.PI * 4 * t)));
    const a = harmonicAmps(f, 5);
    expect(Array.from(a).map((x) => +x.toFixed(6))).toEqual([0, 0.5, 0, 0.25, 0]);
  });
});

describe('frame editing', () => {
  it('drawing strokes sets every point between the mouse positions, either way, clamped to the box', () => {
    const w = new Float32Array(FRAME_POINTS);
    drawStroke(w, 0, 0, 0.5, 1);
    expect(w[0]).toBe(0);
    expect(w[Math.round(0.25 * (FRAME_POINTS - 1))]).toBeCloseTo(0.5, 2);
    expect(w[Math.round(0.5 * (FRAME_POINTS - 1))]).toBeCloseTo(1, 6);
    drawStroke(w, 0.9, -3, 0.8, 3);
    expect(w[Math.round(0.9 * (FRAME_POINTS - 1))]).toBe(-1);
    expect(w[Math.round(0.8 * (FRAME_POINTS - 1))]).toBe(1);
    drawStroke(w, 0.3, 0.25, 0.3, 0.75); // a vertical stroke sets its last point
    expect(w[Math.round(0.3 * (FRAME_POINTS - 1))]).toBeCloseTo(0.75, 6);
  });

  it('draw → table: a hand-drawn saw has the harmonics of a saw (1/k, all in phase)', () => {
    const w = new Float32Array(FRAME_POINTS);
    const strokes = 64;
    // A mouse path in 64 segments from top-left to bottom-right, then back up at the edge.
    for (let i = 0; i < strokes; i++) drawStroke(w, i / strokes, 1 - (2 * i) / strokes, (i + 1) / strokes, 1 - (2 * (i + 1)) / strokes);
    const f = removeDc(frameFromWave(w));
    const a = harmonicAmps(f, 8);
    for (let k = 1; k <= 8; k++) expect((a[k - 1] as number) * k).toBeCloseTo((a[0] as number), 1);
    expect(a[0]).toBeGreaterThan(0.55);
    expect(peakOf(normalizeFrame(f))).toBeCloseTo(1, 6);
  });

  it('smoothing takes the top harmonics away and keeps the fundamental', () => {
    const saw = frameFromWave(cycle(1024, (t) => 1 - 2 * t));
    const soft = smoothFrame(saw, 0.6);
    const hi = (f: ReturnType<typeof newFrame>) => harmonicAmps(f, 256).slice(40).reduce((s, x) => s + x * x, 0);
    expect(hi(soft)).toBeLessThan(hi(saw) * 1e-3);
    expect(harmonicAmps(soft, 1)[0]).toBeGreaterThan(harmonicAmps(saw, 1)[0]! * 0.99);
    expect(maxDiff(smoothFrame(saw, 0).sin, saw.sin)).toBe(0);
  });

  it('normalize puts the peak at 1 (and leaves silence alone); remove DC clears the offset only', () => {
    const f = frameFromWave(cycle(1024, (t) => 0.3 + 0.1 * Math.sin(2 * Math.PI * t)));
    const n = normalizeFrame(f);
    expect(peakOf(n)).toBeCloseTo(1, 6);
    expect(peakOf(normalizeFrame(f, 0.5))).toBeCloseTo(0.5, 6);
    expect(isSilent(normalizeFrame(newFrame()))).toBe(true);
    const d = removeDc(f);
    expect(d.cos[0]).toBe(0);
    expect(d.sin[1]).toBe(f.sin[1]);
    const w = frameToWave(d);
    expect(w.reduce((s, x) => s + x, 0) / w.length).toBeCloseTo(0, 6);
  });

  it('band-limit removes every harmonic above the limit (FFT), optionally with a taper', () => {
    const f = frameFromWave(cycle(1024, (t) => (t < 0.5 ? 1 : -1)));
    const b = bandLimit(f, 20);
    const a = harmonicAmps(b, 256);
    expect(a.slice(20).every((x) => x === 0)).toBe(true);
    expect(a[0]).toBeCloseTo(harmonicAmps(f, 1)[0] as number, 12);
    expect(a[18]).toBeCloseTo(harmonicAmps(f, 20)[18] as number, 12);
    const t = harmonicAmps(bandLimit(f, 20, 6), 256);
    expect(t.slice(20).every((x) => x === 0)).toBe(true);
    expect(t[19]).toBeLessThan(a[18]! * 0.2);
    expect(t[10]).toBeCloseTo(a[10] as number, 12);
  });

  it('harmonic sliders: additive frames, one harmonic changed at a time, phase kept', () => {
    const f = frameFromHarmonics([1, 0.5, 0.25]);
    expect(Array.from(harmonicAmps(f, 4))).toEqual([1, 0.5, 0.25, 0]);
    const g = setHarmonic(f, 2, 0.1);
    expect(Array.from(harmonicAmps(g, 3))).toEqual([1, 0.1, 0.25]);
    expect(setHarmonic(g, 7, 0.4).sin[7]).toBe(0.4);
    const phased = frameFromWave(cycle(1024, (t) => Math.cos(2 * Math.PI * 3 * t + 0.4)));
    const scaled = setHarmonic(phased, 3, 0.5);
    expect(Math.atan2(scaled.cos[3] as number, -(scaled.sin[3] as number))).toBeCloseTo(Math.atan2(phased.cos[3] as number, -(phased.sin[3] as number)), 9);
    expect(frameFromHarmonics([-1, NaN, 2]).sin.slice(1, 4)).toEqual(Float64Array.from([0, 0, 2]));
  });

  it('invert flips the shape, reverse mirrors it', () => {
    const ramp = frameFromWave(cycle(1024, (t) => Math.sin(2 * Math.PI * t) + 0.5 * Math.sin(2 * Math.PI * 2 * t + 1)));
    const inv = frameToWave(invertFrame(ramp));
    const w = frameToWave(ramp);
    for (let i = 0; i < w.length; i++) expect(inv[i]).toBeCloseTo(-(w[i] as number), 6);
    const rev = frameToWave(reverseFrame(ramp));
    for (let i = 1; i < w.length; i++) expect(rev[i]).toBeCloseTo(w[w.length - i] as number, 5);
  });

  it('morphing blends two frames, and filling between key frames gives evenly spaced steps', () => {
    const a = frameFromHarmonics([1]);
    const b = frameFromHarmonics([0, 1]);
    const mid = morphFrames(a, b, 0.5);
    expect(mid.sin[1]).toBe(0.5);
    expect(mid.sin[2]).toBe(0.5);
    const between = framesBetween(a, b, 3);
    expect(between.map((f) => f.sin[2])).toEqual([0.25, 0.5, 0.75]);
    // The table's shape at a position blends the neighbouring key frames, as the oscillator does.
    expect(frameAt([a, b], 0.25).sin[1]).toBe(0.75);
    expect(frameAt([a, b, a], 0.5).sin[2]).toBe(1);
    expect(frameAt([], 0.5).sin[1]).toBe(1);
  });
});

describe('importing audio', () => {
  it('a single-cycle file becomes one frame with its DC removed and its peak at 1', () => {
    const frames = framesFromCycles(cycle(2048, (t) => 0.4 + 0.2 * Math.sin(2 * Math.PI * t)), 2048);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.cos[0]).toBe(0);
    expect(peakOf(frames[0] as never)).toBeCloseTo(1, 6);
  });

  it('a file of cycles becomes a frame each, thinned to 32 when there are more', () => {
    const many = Float32Array.from({ length: 2048 * 100 }, (_, i) => Math.sin((2 * Math.PI * (1 + Math.floor(i / 2048) / 20) * (i % 2048)) / 2048));
    const frames = framesFromCycles(many, 2048);
    expect(frames).toHaveLength(MAX_FRAMES);
    // Evenly spread: the first and the last cycle are both in.
    expect(frames[0]!.sin[1]).toBeCloseTo(1, 3);
    expect(thin([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4)).toEqual([1, 4, 7, 10]);
    expect(framesFromCycles(cycle(300, (t) => Math.sin(2 * Math.PI * t)), 2048)).toHaveLength(1);
  });

  it('slicing a sample into N parts gives N frames that follow its changing sound', () => {
    // A tone whose pitch jumps from partial 3 to partial 9 half way: the early frames hold 3, the late ones 9.
    const n = 48000;
    const audio = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * (i < n / 2 ? 3 : 9) * i) / (n / 8)));
    const frames = framesFromSlices(audio, 4);
    expect(frames).toHaveLength(4);
    const dominant = (f: ReturnType<typeof newFrame>) => {
      const a = harmonicAmps(f, 64);
      return a.indexOf(Math.max(...a)) + 1;
    };
    // The 8 cycles per file make the first half read as harmonic ~12 and the second as ~36 of each 12000-sample part.
    expect(dominant(frames[0] as never)).toBeLessThan(dominant(frames[3] as never));
    for (const f of frames) expect(peakOf(f)).toBeCloseTo(1, 6);
    expect(framesFromSlices(audio, 100)).toHaveLength(MAX_FRAMES);
  });
});

describe('WAV files', () => {
  it('exports the table as 32-bit float with a cycle-size chunk and reads it back', () => {
    const frames = [frameFromHarmonics([1]), frameFromHarmonics([1, 0.5, 0.33])];
    const bytes = encodeWav(frames, 2048);
    const wav = decodeWav(bytes);
    expect(wav).not.toBeNull();
    expect(wav!.cycleLength).toBe(2048);
    expect(wav!.channels).toHaveLength(1);
    expect(wav!.channels[0]).toHaveLength(2 * 2048);
    const back = framesFromCycles(wav!.channels[0] as Float32Array, wav!.cycleLength);
    expect(back).toHaveLength(2);
    expect(Array.from(harmonicAmps(back[1] as never, 3)).map((x) => +(x / (harmonicAmps(back[1] as never, 1)[0] as number)).toFixed(3))).toEqual([1, 0.5, 0.33]);
  });

  it('reads 16-bit and 24-bit PCM, stereo files and rejects everything else', () => {
    const header = (bits: number, channels: number, dataBytes: number) => {
      const out = new Uint8Array(44 + dataBytes);
      const dv = new DataView(out.buffer);
      const put = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
      put(0, 'RIFF');
      dv.setUint32(4, 36 + dataBytes, true);
      put(8, 'WAVE');
      put(12, 'fmt ');
      dv.setUint32(16, 16, true);
      dv.setUint16(20, 1, true);
      dv.setUint16(22, channels, true);
      dv.setUint32(24, 44100, true);
      dv.setUint32(28, (44100 * channels * bits) / 8, true);
      dv.setUint16(32, (channels * bits) / 8, true);
      dv.setUint16(34, bits, true);
      put(36, 'data');
      dv.setUint32(40, dataBytes, true);
      return { out, dv };
    };
    const p16 = header(16, 2, 8);
    p16.dv.setInt16(44, 16384, true);
    p16.dv.setInt16(46, -16384, true);
    p16.dv.setInt16(48, 32767, true);
    p16.dv.setInt16(50, -32768, true);
    const w16 = decodeWav(p16.out)!;
    expect(w16.channels).toHaveLength(2);
    expect(w16.channels[0]![0]).toBeCloseTo(0.5, 6);
    expect(w16.channels[1]![0]).toBeCloseTo(-0.5, 6);
    expect(w16.channels[1]![1]).toBe(-1);
    const p24 = header(24, 1, 3);
    p24.out.set([0x00, 0x00, 0xc0], 44);
    expect(decodeWav(p24.out)!.channels[0]![0]).toBeCloseTo(-0.5, 6);
    expect(decodeWav(new Uint8Array(100))).toBeNull();
    const mp3ish = new Uint8Array(64);
    expect(decodeWav(mp3ish)).toBeNull();
  });
});

describe('storage in the plugin state', () => {
  const sample = () => frameFromWave(cycle(1024, (t) => Math.sin(2 * Math.PI * t) + 0.4 * Math.sin(2 * Math.PI * 5 * t + 1) + (t < 0.3 ? 0.2 : 0)));

  it('a frame survives its string to within the 16-bit rounding (under −60 dB of its peak)', () => {
    const f = sample();
    const g = decodeFrame(encodeFrame(f)) as ReturnType<typeof newFrame>;
    expect(g).not.toBeNull();
    expect(maxDiff(frameToWave(g), frameToWave(f))).toBeLessThan(1e-3 * peakOf(f));
  });

  it('is compact: a few harmonics are a few bytes, never more than 1 KB a frame', () => {
    const few = encodeFrame(frameFromHarmonics([1, 0.5, 0.25]));
    expect(few.length).toBe(Math.ceil((8 + 4 * 3) / 3) * 4);
    const full = newFrame();
    for (let k = 1; k <= 256; k++) {
      full.sin[k] = 1 / k;
      full.cos[k] = 0.5 / k;
    }
    expect(encodeFrame(full).length).toBe(Math.ceil((8 + 4 * 256) / 3) * 4);
    expect(encodeFrame(newFrame())).toBe(encodeFrame(newFrame()));
    expect(decodeFrame(encodeFrame(newFrame()))).not.toBeNull();
    // A whole 8-frame drawn table stays well below 12 KB of JSON.
    const table = Array.from({ length: 8 }, () => full);
    expect(JSON.stringify(userTableState(table)).length).toBeLessThan(12_000);
  });

  it('refuses strings that are not frames', () => {
    for (const bad of ['', 'not base64!!', 'AAAA', '/////wAAAAA=', 'AQD/////AAA='])
      expect(decodeFrame(bad)).toBeNull();
  });

  it('the state helpers: a table in, the same frames out; garbage and older states become an empty table', () => {
    const f = [sample(), frameFromHarmonics([1, 1])];
    const state = userTableState(f);
    expect(state.v).toBe(2);
    expect(state.user!.frames).toHaveLength(2);
    expect(framesOfState(state)).toHaveLength(2);
    expect(userTableState([])).toEqual(EMPTY_TABLE_STATE);
    for (const raw of [undefined, null, 5, 'x', {}, { user: 3 }, { user: { frames: 'no' } }, { user: { frames: ['nope'] } }, { v: 1 }])
      expect(readUserTableState(raw)).toEqual(EMPTY_TABLE_STATE);
    // Damaged frames are dropped, good ones kept.
    const mixed = readUserTableState({ v: 2, user: { frames: [state.user!.frames[0], 'junk', 7] } });
    expect(mixed.user!.frames).toEqual([state.user!.frames[0]]);
    expect(userTableState(Array.from({ length: 50 }, sample)).user!.frames).toHaveLength(MAX_FRAMES);
  });
});

describe('the band-limited bank', () => {
  it('one table of one frame per key frame, each at its own peak of 1', () => {
    const bank = buildFrameBank([frameFromHarmonics([1]), frameFromHarmonics([1, 0.5]), frameFromHarmonics([0, 0, 1])]);
    expect(bank.tables).toBe(1);
    expect(bank.frames).toBe(3);
    for (let f = 0; f < 3; f++) {
      const o = bank.offset(0, f, 0);
      let peak = 0;
      for (let i = 0; i < WavetableBank.size(0); i++) peak = Math.max(peak, Math.abs(bank.data[o + i] as number));
      expect(peak).toBeCloseTo(1, 5);
    }
    // An empty table plays one sine frame.
    const empty = buildFrameBank([]);
    expect(empty.frames).toBe(1);
    expect(bank.sample(0, 0, 0.25, 0)).toBeCloseTo(1, 5);
  });

  it('level m keeps only harmonics up to 256 >> m, so nothing can alias at high notes', () => {
    // A frame with every harmonic present (a hand-drawn square: all odd harmonics to 256).
    const square = frameFromWave(cycle(1024, (t) => (t < 0.5 ? 1 : -1)));
    const bank = buildFrameBank([square]);
    for (let m = 0; m < WT_LEVELS; m++) {
      const n = WavetableBank.size(m);
      const o = bank.offset(0, 0, m);
      const re = Float64Array.from(bank.data.subarray(o, o + n));
      const im = new Float64Array(n);
      // Direct DFT of the harmonics around the limit.
      const mag = (k: number) => {
        let c = 0;
        let s = 0;
        for (let j = 0; j < n; j++) {
          c += (re[j] as number) * Math.cos((2 * Math.PI * k * j) / n);
          s += (re[j] as number) * Math.sin((2 * Math.PI * k * j) / n);
        }
        return Math.hypot(c, s) / n;
      };
      void im;
      const limit = 256 >> m;
      if (limit >= 3) {
        expect(mag(limit - 1)).toBeGreaterThan(1e-3);
        expect(mag(limit + 2)).toBeLessThan(1e-5);
      }
    }
  });
});
