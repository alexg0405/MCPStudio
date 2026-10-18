import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ParamValue } from '@agstudio/sdk';
import {
  bitHash,
  paramBlock,
  peak,
  renderInstrument,
  rms,
  testHost,
  testTransport,
  type KernelEvent,
} from '@agstudio/sdk/testing';
import { GranularKernel } from './kernel';
import { GRAIN_SHAPES, granularParams, TELEMETRY_GRAINS } from './params';
import { GRANULAR_PRESETS } from './presets';
import { buildTexture, TEXTURE_RATE } from './textures.kernel';

const SR = 48000;

/** One channel of `seconds` of audio from a function of the time. */
const audio = (seconds: number, f: (t: number) => number) =>
  Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => f(i / SR));

/** A kernel with a sample loaded (the built-in texture otherwise isn't sent, so it is silent without one). */
function kernel(sample: Float32Array | null, seed = 7) {
  const k = new GranularKernel(testHost(SR, seed));
  k.transport = testTransport({ playing: true, bpm: 120, sampleRate: SR });
  if (sample) k.onSample('main', [sample], SR);
  return k;
}

/** Values for measuring: no filter, no spread, no velocity response, a flat grain with 50 ms fades. */
const PLAIN: Record<string, ParamValue> = {
  filterType: 'off',
  spread: 0,
  velocity: 0,
  keyTrack: 0,
  shape: 'flat',
  ampAttack: 0.001,
  ampSustain: 1,
  jitter: 0,
  spray: 0,
  level: 0,
};

type Notes = [frame: number, key: number, offFrame?: number][];

function play(
  k: GranularKernel,
  values: Record<string, ParamValue> | ((frame: number) => Record<string, ParamValue>),
  seconds: number,
  notes: Notes = [[0, 60]],
  extra: KernelEvent[] = [],
) {
  const events: KernelEvent[] = [...extra];
  notes.forEach(([frame, key, off], i) => {
    events.push({ frame, run: () => k.noteOn(key, 1, i + 1, 0, 0) });
    if (off !== undefined) events.push({ frame: off, run: () => k.noteOff(i + 1, key, 0.5) });
  });
  const block = (frame: number) =>
    paramBlock(granularParams, { ...PLAIN, ...(typeof values === 'function' ? values(frame) : values) });
  return renderInstrument(k, Math.round(seconds * SR), block, events);
}

const mean = (x: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] as number;
  return s / (to - from);
};

describe('Granular kernel: grains', () => {
  it('is silent without a source, and sounds with the built-in texture once it arrives', () => {
    const k = kernel(null);
    const [silent] = play(k, {}, 0.3);
    expect(peak(silent as Float32Array)).toBe(0);
    const k2 = kernel(null);
    const [t0, t1] = buildTexture('choir');
    k2.onMessage({ type: 'texture', channels: [t0, t1], sampleRate: TEXTURE_RATE });
    const [l] = play(k2, {}, 0.6);
    expect(rms(l as Float32Array, 4800)).toBeGreaterThan(0.01);
    // A loaded sample wins over the texture; removing it brings the texture back.
    k2.onSample('main', [audio(1, () => 0)], SR);
    const [quiet] = play(k2, {}, 0.3);
    expect(peak(quiet as Float32Array)).toBe(0);
    k2.onSample('main', null, SR);
    expect(rms(play(k2, {}, 0.6)[0] as Float32Array, 4800)).toBeGreaterThan(0.01);
  });

  it('density sets how many grains start: one every 1/density second, per note', () => {
    for (const density of [10, 25, 100]) {
      const k = kernel(audio(2, (t) => Math.sin(2 * Math.PI * 220 * t)));
      play(k, { density, size: 50 }, 2);
      expect(Math.abs(k.grainsStarted - density * 2), `density ${density}`).toBeLessThanOrEqual(2);
    }
    // Two notes make two clouds.
    const k = kernel(audio(2, (t) => Math.sin(2 * Math.PI * 220 * t)));
    play(k, { density: 20, size: 50 }, 2, [
      [0, 60],
      [0, 64],
    ]);
    expect(Math.abs(k.grainsStarted - 80)).toBeLessThanOrEqual(3);
    // Timing randomness keeps the average rate.
    const r = kernel(audio(2, (t) => Math.sin(2 * Math.PI * 220 * t)));
    play(r, { density: 50, size: 30, jitter: 0.8 }, 4);
    expect(r.grainsStarted / 4).toBeGreaterThan(40);
    expect(r.grainsStarted / 4).toBeLessThan(60);
  });

  it('grain size sets how long grains last: the number sounding at once is about density × size', () => {
    const sounding = (size: number) => {
      const k = kernel(audio(2, (t) => Math.sin(2 * Math.PI * 220 * t)));
      const counts: number[] = [];
      const probes = Array.from({ length: 40 }, (_, i) => ({
        frame: Math.round((0.5 + i * 0.03) * SR),
        run: () => counts.push(k.grainsActive),
      }));
      play(k, { density: 40, size }, 2, [[0, 60]], probes);
      return counts.reduce((a, b) => a + b, 0) / counts.length;
    };
    const short = sounding(50);
    const long = sounding(200);
    expect(short).toBeGreaterThan(1.4);
    expect(short).toBeLessThan(2.8);
    expect(long).toBeGreaterThan(6);
    expect(long).toBeLessThan(10);
  });

  it('position picks where in the sample the grains come from (a rising ramp is louder further on)', () => {
    const ramp = audio(10, (t) => t / 10);
    const level = (position: number) => mean(play(kernel(ramp), { position, size: 60, density: 40 }, 1)[0] as Float32Array, 9600, SR);
    expect(level(0.8) / level(0.2)).toBeGreaterThan(3);
    expect(level(0.8) / level(0.2)).toBeLessThan(5);
  });

  it('spray scatters the position around it (the ramp\'s level then varies from grain to grain)', () => {
    const ramp = audio(10, (t) => t / 10);
    const spread = (spray: number) => {
      const k = kernel(ramp);
      const positions: number[] = [];
      const probes = Array.from({ length: 60 }, (_, i) => ({
        frame: Math.round((0.1 + i * 0.05) * SR),
        run: () => positions.push(k.lastGrainPosition),
      }));
      play(k, { position: 0.5, spray, density: 40, size: 60 }, 3.2, [[0, 60]], probes);
      return Math.max(...positions) - Math.min(...positions);
    };
    expect(spread(0)).toBeLessThan(1e-9);
    expect(spread(0.2)).toBeGreaterThan(0.2);
    expect(spread(0.2)).toBeLessThanOrEqual(0.4 + 1e-9);
  });

  it('scan moves the position at the sample\'s speed, backwards when negative, and freeze holds it', () => {
    const ramp = audio(10, (t) => t / 10);
    const track = (values: (frame: number) => Record<string, ParamValue>, at: number[]) => {
      const k = kernel(ramp);
      const seen: number[] = [];
      const probes = at.map((t) => ({ frame: Math.round(t * SR), run: () => seen.push(k.lastGrainPosition) }));
      play(k, (f) => ({ position: 0.1, density: 40, size: 40, ...values(f) }), 3.2, [[0, 60]], probes);
      return seen;
    };
    // 1x: one second of sample (a tenth of this 10 s ramp) per second.
    const forward = track(() => ({ scan: 1 }), [0.5, 1.5, 2.5]);
    expect(forward[1]! - forward[0]!).toBeCloseTo(0.1, 1);
    expect(forward[2]! - forward[1]!).toBeCloseTo(0.1, 1);
    const back = track(() => ({ scan: -1, position: 0.9 }), [0.5, 1.5]);
    expect(back[0]! - back[1]!).toBeCloseTo(0.1, 1);
    const still = track(() => ({ scan: 0 }), [0.5, 2.5]);
    expect(still[1]).toBeCloseTo(still[0] as number, 6);
    // Freeze (switched on at 1 s): it keeps the spot it had reached.
    const frozen = track((f) => ({ scan: 1, freeze: f >= SR }), [0.5, 1.2, 2.0, 3.0]);
    expect(frozen[1]! - frozen[0]!).toBeGreaterThan(0.05);
    expect(frozen[3]).toBeCloseTo(frozen[2] as number, 6);
    expect(frozen[2]).toBeCloseTo(frozen[1]! + 0, 1);
    // And it moves again when released.
    const released = track((f) => ({ scan: 1, freeze: f >= SR && f < 2 * SR }), [1.5, 2.9]);
    // Frozen from 1 s to 2 s, so it moves for the 0.9 s between 2.0 and 2.9 s.
    expect(released[1]! - released[0]!).toBeGreaterThan(0.08);
  });

  it('a tempo-synced scan makes one pass per chosen length, locked to the song', () => {
    const ramp = audio(10, (t) => t / 10);
    const k = kernel(ramp);
    const seen: number[] = [];
    // At 120 BPM a beat is 0.5 s: a 1-bar length is 2 s.
    const probes = [0.25, 0.75, 1.25, 1.75, 2.25].map((t) => ({ frame: Math.round(t * SR), run: () => seen.push(k.lastGrainPosition) }));
    play(k, { position: 0, scanSync: true, scanLength: '1bar', scan: 1, density: 60, size: 30 }, 2.5, [[0, 60]], probes);
    expect(seen[0]).toBeCloseTo(0.125, 1);
    expect(seen[1]).toBeCloseTo(0.375, 1);
    expect(seen[3]).toBeCloseTo(0.875, 1);
    // It wraps into the next pass.
    expect(seen[4]).toBeCloseTo(0.125, 1);
  });

  it('pitch follows the key (one octave per twelve semitones) unless key tracking is off', () => {
    const sine = audio(2, (t) => Math.sin(2 * Math.PI * 220 * t));
    // The pitch from the typical gap between upward zero crossings (grains and their gaps don't disturb a median).
    const freq = (x: Float32Array) => {
      const gaps: number[] = [];
      let last = -1;
      for (let i = 9601; i < SR; i++)
        if ((x[i - 1] as number) < 0 && (x[i] as number) >= 0) {
          if (last >= 0) gaps.push(i - last);
          last = i;
        }
      gaps.sort((a, b) => a - b);
      return SR / (gaps[Math.floor(gaps.length / 2)] as number);
    };
    const base = freq(play(kernel(sine), { size: 200, density: 4, keyTrack: 1 }, 1, [[0, 60]])[0] as Float32Array);
    expect(base).toBeGreaterThan(200);
    expect(base).toBeLessThan(250);
    const octave = freq(play(kernel(sine), { size: 200, density: 4, keyTrack: 1 }, 1, [[0, 72]])[0] as Float32Array);
    expect(octave / base).toBeGreaterThan(1.9);
    expect(octave / base).toBeLessThan(2.1);
    const flat = freq(play(kernel(sine), { size: 200, density: 4, keyTrack: 0 }, 1, [[0, 72]])[0] as Float32Array);
    expect(flat / base).toBeGreaterThan(0.9);
    expect(flat / base).toBeLessThan(1.1);
    const up = freq(play(kernel(sine), { size: 200, density: 4, pitch: 12 }, 1, [[0, 60]])[0] as Float32Array);
    expect(up / base).toBeGreaterThan(1.9);
  });

  it('stereo spread puts grains left and right, and none keeps the cloud in the middle', () => {
    const sine = audio(2, (t) => Math.sin(2 * Math.PI * 220 * t));
    const [l0, r0] = play(kernel(sine), { spread: 0 }, 1);
    expect(l0).toEqual(r0);
    const [l1, r1] = play(kernel(sine), { spread: 1, density: 30, size: 40 }, 1);
    let diff = 0;
    for (let i = 4800; i < SR; i++) diff += ((l1[i] as number) - (r1[i] as number)) ** 2;
    expect(Math.sqrt(diff / (SR - 4800))).toBeGreaterThan(0.02);
  });

  it('reverse plays grains backwards: a rising ramp read backwards falls inside each grain', () => {
    const ramp = audio(10, (t) => t / 10);
    // One long grain at a time, no overlap: its slope tells the direction.
    const slope = (reverse: number) => {
      const [l] = play(kernel(ramp), { position: 0.5, reverse, density: 4, size: 200, shape: 'flat' }, 0.6);
      const x = l as Float32Array;
      const i = Math.round(0.1 * SR);
      return (x[i + 400] as number) - (x[i] as number);
    };
    expect(slope(0)).toBeGreaterThan(0);
    expect(slope(1)).toBeLessThan(0);
  });
});

describe('Granular kernel: sound quality', () => {
  it('every grain shape fades in and out smoothly: no step at a grain\'s edges (a clean sine stays clean)', () => {
    const sine = audio(2, (t) => Math.sin(2 * Math.PI * 110 * t));
    for (const [shape] of GRAIN_SHAPES) {
      // Grains that do not overlap, so each can be seen alone: the biggest step between samples is the sine's own slope.
      const [l] = play(kernel(sine), { shape, size: 100, density: 5, spread: 0, position: 0.1 }, 1.5);
      const x = l as Float32Array;
      let step = 0;
      for (let i = 1; i < x.length; i++) step = Math.max(step, Math.abs((x[i] as number) - (x[i - 1] as number)));
      expect(step / peak(x), shape).toBeLessThan(0.025);
    }
  });

  it('a dense cloud stays smooth too (the steps stay a small share of the level)', () => {
    const sine = audio(2, (t) => Math.sin(2 * Math.PI * 110 * t));
    const [l] = play(kernel(sine), { size: 30, density: 80, spread: 1, jitter: 1, spray: 0.3 }, 1.5);
    const x = l as Float32Array;
    let step = 0;
    for (let i = 1; i < x.length; i++) step = Math.max(step, Math.abs((x[i] as number) - (x[i - 1] as number)));
    expect(step / peak(x)).toBeLessThan(0.08);
  });

  it('the level stays about the same whatever the density and size', () => {
    // Noise, so grains add up the way real material does (a pure tone at regular intervals would comb-filter itself).
    let seed = 12345;
    const noise = audio(2, () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1);
    const level = (values: Record<string, ParamValue>) =>
      rms(play(kernel(noise), { spread: 0.5, jitter: 0.5, ...values }, 1.5)[0] as Float32Array, 24000);
    const sparse = level({ density: 20, size: 100, shape: 'hann' });
    const dense = level({ density: 120, size: 200, shape: 'hann' });
    expect(dense / sparse).toBeGreaterThan(0.5);
    expect(dense / sparse).toBeLessThan(2);
  });

  it('every preset is finite, below full scale with a chord, and clearly audible', () => {
    for (const preset of GRANULAR_PRESETS) {
      const k = kernel(null);
      const texture = buildTexture(String(preset.params?.texture ?? 'choir'));
      k.onMessage({ type: 'texture', channels: texture, sampleRate: TEXTURE_RATE });
      const keys = [48, 60, 64, 67];
      const [l, r] = renderInstrument(
        k,
        2 * SR,
        paramBlock(granularParams, preset.params as Record<string, ParamValue>),
        keys.map((key, i) => ({ frame: 0, run: () => k.noteOn(key, 0.8, i + 1, 0, 0) })),
      );
      for (const ch of [l, r] as Float32Array[]) {
        expect(ch.every(Number.isFinite), preset.name).toBe(true);
        expect(peak(ch), preset.name).toBeLessThan(0.9);
      }
      expect(rms(l as Float32Array, SR / 2), preset.name).toBeGreaterThan(0.05);
    }
  });

  it('works with a tiny sample and extreme pitch (reads wrap, nothing runs out of range)', () => {
    const tiny = audio(0.002, (t) => Math.sin(2 * Math.PI * 1000 * t));
    const [l] = play(kernel(tiny), { pitch: 24, pitchSpray: 12, keyTrack: 1, size: 5, density: 200, reverse: 0.5 }, 0.5, [[0, 127]]);
    expect((l as Float32Array).every(Number.isFinite)).toBe(true);
  });
});

describe('Granular kernel: notes', () => {
  const sine = audio(2, (t) => Math.sin(2 * Math.PI * 220 * t));

  it('is deterministic: the same seed repeats exactly, another seed differs', () => {
    const run = (seed: number, hostSeed = 7) =>
      bitHash(play(kernel(sine, hostSeed), { seed, spray: 0.4, spread: 1, jitter: 1, pitchSpray: 3, reverse: 0.3 }, 0.8)[0] as Float32Array);
    expect(run(5)).toBe(run(5));
    expect(run(5)).not.toBe(run(6));
    // Chunked differently, it is the same sound.
    const a = play(kernel(sine), { seed: 3, spray: 0.4, jitter: 1 }, 0.5)[0] as Float32Array;
    const b = renderInstrument(
      (() => {
        const k = kernel(sine);
        k.noteOn(60, 1, 1, 0, 0);
        return k;
      })(),
      Math.round(0.5 * SR),
      () => paramBlock(granularParams, { ...PLAIN, seed: 3, spray: 0.4, jitter: 1 }),
      [],
      64,
    )[0];
    expect(Math.abs(rms(a) - rms(b))).toBeLessThan(rms(a) * 0.15);
  });

  it('ends after its release, and a cancelled note never sounds', () => {
    const [x] = play(kernel(sine), { ampRelease: 0.1, density: 40, size: 50 }, 1, [[0, 60, SR / 4]]);
    expect(rms(x as Float32Array, 2400, 9600)).toBeGreaterThan(0.01);
    expect(peak(x as Float32Array, SR / 4 + 0.3 * SR)).toBe(0);
    const [y] = play(kernel(sine), {}, 0.3, [[0, 60, 0]]);
    expect(peak(y as Float32Array)).toBe(0);
  });

  it('plays chords, and the voices knob makes the oldest note give way', () => {
    const chord: Notes = [
      [0, 48],
      [0, 55],
      [0, 60],
      [0, 64],
    ];
    const all = rms(play(kernel(sine), { voices: 8 }, 1, chord)[0] as Float32Array, 9600);
    const one = rms(play(kernel(sine), { voices: 1 }, 1, [[0, 48]])[0] as Float32Array, 9600);
    expect(all / one).toBeGreaterThan(1.3);
    // With one voice the last note alone remains.
    const k = kernel(sine);
    play(k, { voices: 1 }, 1, chord);
    const sounding = k.grainsActive;
    expect(sounding).toBeLessThanOrEqual(64);
    const limited = rms(play(kernel(sine), { voices: 1 }, 1, chord)[0] as Float32Array, 9600);
    expect(limited / one).toBeLessThan(1.5);
  });

  it('a hard all-notes-off silences at once', () => {
    const k = kernel(sine);
    const [x] = play(k, {}, 0.5, [[0, 60]], [{ frame: 4800, run: () => k.allNotesOff(true) }]);
    expect(peak(x as Float32Array, 4800 + 8)).toBe(0);
  });

  it('the filter darkens (low-pass) and thins (high-pass) the cloud', () => {
    const level = (tone: number, values: Record<string, ParamValue>) =>
      rms(play(kernel(audio(2, (t) => Math.sin(2 * Math.PI * tone * t))), { density: 60, size: 60, ...values }, 1)[0] as Float32Array, 9600);
    expect(level(6000, { filterType: 'lp', cutoff: 500 })).toBeLessThan(level(6000, { filterType: 'off' }) * 0.1);
    expect(level(200, { filterType: 'lp', cutoff: 500 })).toBeGreaterThan(level(200, { filterType: 'off' }) * 0.7);
    expect(level(200, { filterType: 'hp', cutoff: 3000 })).toBeLessThan(level(200, { filterType: 'off' }) * 0.1);
    expect(level(6000, { filterType: 'hp', cutoff: 3000 })).toBeGreaterThan(level(6000, { filterType: 'off' }) * 0.7);
  });

  it('reports its newest grains to the editor: position, progress and pan', () => {
    const k = kernel(sine);
    const host = (k as unknown as { host: { posted: unknown[] } }).host;
    play(k, { position: 0.5, density: 30, size: 100, spread: 0.5 }, 0.6);
    const readings = host.posted
      .map((m) => (m as { readings?: Record<string, number> }).readings)
      .filter((r): r is Record<string, number> => !!r);
    expect(readings.length).toBeGreaterThan(5);
    const last = readings[readings.length - 1] as Record<string, number>;
    expect(last.grains).toBeGreaterThan(0);
    expect(last.voices).toBe(1);
    for (let i = 0; i < last.grains!; i++) {
      expect(last[`gp${i}`]).toBeGreaterThan(0.3);
      expect(last[`gp${i}`]).toBeLessThan(0.7);
      expect(last[`gq${i}`]).toBeGreaterThanOrEqual(0);
      expect(last[`gq${i}`]).toBeLessThanOrEqual(1);
      expect(Math.abs(last[`gx${i}`] as number)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
    expect(last[`gp${TELEMETRY_GRAINS - 1}`]).toBe(-1);
  });
});

describe('Granular kernel: the audio thread', () => {
  it('allocates nothing between its markers (no new, literals, closures, spreads or array methods)', () => {
    const files = ['kernel.ts', 'voice.kernel.ts'].map((f) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
    const kernelSource = files[0] as string;
    const start = kernelSource.indexOf('// --- Audio thread: nothing below allocates');
    const end = kernelSource.indexOf('// --- End of the audio thread');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // The kernel's region, and the voice's methods that run in it (spawn, renderGrains, setFilter, random).
    const voice = files[1] as string;
    const voiceStart = voice.indexOf('  /** Restarts the voice');
    const regions = [kernelSource.slice(start, end), voice.slice(voiceStart)].map((text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        // Typed-array reads and arithmetic only: drop the declarations that legitimately build once.
        .replace(/readonly \w+ = new [^;]+;/g, ''),
    );
    const forbidden: [string, RegExp][] = [
      ['new', /\bnew\s/],
      ['an array literal', /(^|[=(,:?&|]|\breturn)\s*\[/m],
      ['an object literal', /(^|[=(,:?&|]|\breturn)\s*\{/m],
      ['a closure', /=>|\bfunction\b/],
      ['a template string', /`/],
      ['a spread', /\.\.\./],
      ['an array method', /\.(map|filter|slice|concat|push|pop|splice|reduce|forEach|from|of)\(/],
    ];
    for (const region of regions)
      for (const [what, pattern] of forbidden) {
        // Allowed: `{` that opens a block (if/for/else/method), which the object-literal pattern can't tell apart.
        if (what === 'an object literal') continue;
        expect(region, `the audio thread's code has ${what}`).not.toMatch(pattern);
      }
  });
});
