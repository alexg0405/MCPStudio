import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SCALES } from '@agstudio/sdk/notes';
import { paramBlock, runEffect, type TestParams, type TestSignal } from '@agstudio/sdk/testing';
import harmonizer from './index';
import { HarmonizerKernel } from './kernel';
import source from './kernel.ts?raw';
import { harmonizerLatencyFrames, harmonizerParams, HARMONIZER_SCALES, MAX_VOICES } from './params';
import harmonySource from './harmony.kernel.ts?raw';
import shifterSource from './shifter.kernel.ts?raw';
import voiceSource from './voice.kernel.ts?raw';
import {
  foldNearPitch,
  heldKeyAbove,
  heldKeyBelow,
  nearestHeldKey,
  nearestScaleNote,
  scaleMaskOf,
  scaleStepSemitones,
} from './harmony.kernel';

const SR = 48000;
const LATENCY = harmonizerLatencyFrames(SR);
type Params = TestParams<typeof harmonizerParams>;

/**
 * A signal built from a pitch that may move: the phase is the running sum of the frequency (the test runner asks for
 * every frame in order, left channel first), and `shape` turns the phase into a sample.
 */
function movingPitch(hz: number | ((frame: number) => number), shape: (phase: number) => number): TestSignal {
  let phase = 0;
  let lastFrame = -1;
  return (frame) => {
    if (frame !== lastFrame) {
      lastFrame = frame;
      phase += (2 * Math.PI * (typeof hz === 'number' ? hz : hz(frame))) / SR;
    }
    return shape(phase);
  };
}

/** A harmonic tone, like a sung vowel (so the pitch detector is sure of it): six harmonics with a 1/k roll-off. */
const voiceAt = (hz: number | ((frame: number) => number), amp = 0.3): TestSignal =>
  movingPitch(hz, (phase) => {
    let sum = 0;
    for (let k = 1; k <= 6; k++) sum += Math.sin(k * phase) / k;
    return amp * sum * 0.5;
  });

/** A pure sine (the cleanest signal to measure a shifted pitch on). */
const sine = (hz: number | ((frame: number) => number), amp = 0.4): TestSignal =>
  movingPitch(hz, (phase) => amp * Math.sin(phase));

const hzOfMidi = (note: number) => 440 * Math.pow(2, (note - 69) / 12);
const semitones = (n: number) => Math.pow(2, n / 12);

/** The strength of one frequency in a Hann-windowed copy of `windowed` (a DFT at that single frequency). */
function lineLevel(windowed: Float64Array, from: number, hz: number): number {
  const step = (2 * Math.PI * hz) / SR;
  let re = 0;
  let im = 0;
  for (let i = 0; i < windowed.length; i++) {
    re += (windowed[i] as number) * Math.cos(step * (from + i));
    im += (windowed[i] as number) * Math.sin(step * (from + i));
  }
  return Math.hypot(re, im) / windowed.length;
}

/**
 * Where the strongest spectral line within 60 cents of `nearHz` sits, as a distance in cents from `nearHz`, and its
 * level. Hann-windowed DFT of x over [from, to): a coarse scan in 3-cent steps, then a half-cent scan around the best:
 * exact enough for a clean tone.
 */
function peakNear(x: Float32Array, from: number, to: number, nearHz: number): { offsetCents: number; level: number } {
  const length = to - from;
  const windowed = new Float64Array(length);
  for (let i = 0; i < length; i++) windowed[i] = (x[from + i] as number) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1)));
  const levelAtOffset = (offset: number) => lineLevel(windowed, from, nearHz * Math.pow(2, offset / 1200));
  let bestOffset = 0;
  let bestLevel = -1;
  const consider = (offset: number) => {
    const level = levelAtOffset(offset);
    if (level <= bestLevel) return;
    bestLevel = level;
    bestOffset = offset;
  };
  for (let offset = -60; offset <= 60; offset += 3) consider(offset);
  const coarseBest = bestOffset;
  for (let offset = coarseBest - 2.5; offset <= coarseBest + 2.5; offset += 0.5) consider(offset);
  return { offsetCents: bestOffset, level: bestLevel };
}

/** Level (as peakNear) of the strongest line near `hz`, relative to the quiet floor: how much sound is there at all. */
const levelAt = (x: Float32Array, from: number, to: number, hz: number) => peakNear(x, from, to, hz).level;

/** One voice, wet only and centred, so the output is just that voice. */
const SINGLE_VOICE: Params = { voices: 1, mix: 1, pan1: 0, level1: 0, humanize: 0, tighten: 0 };

/** The harmonizer on a stepped input; returns the left output (one voice, panned left... centred means L = R). */
function stepped(
  notes: readonly number[],
  params: Params,
  { seconds = 0.8, formant = false }: { seconds?: number; formant?: boolean } = {},
): Float32Array {
  const frames = Math.round(seconds * SR);
  const pitchAt = (frame: number) => hzOfMidi(notes[Math.min(notes.length - 1, Math.floor(frame / frames))] as number);
  // Keeping formants needs a voice with harmonics: a pure sine has no vowel colour to keep, so its pitch cannot be moved that way.
  const input = formant ? voiceAt(pitchAt) : sine(pitchAt);
  return runEffect(HarmonizerKernel, harmonizerParams, input, frames * notes.length, {
    params: { ...SINGLE_VOICE, formant, ...params },
  })[0];
}

/** Checks that during each note of a stepped input the voice sits at `expectedSemitones[i]` above it, within `toleranceCents`. */
function expectIntervals(
  notes: readonly number[],
  expectedSemitones: readonly number[],
  params: Params,
  toleranceCents: number,
  formant: boolean,
): void {
  const seconds = 0.8;
  const out = stepped(notes, params, { seconds, formant });
  notes.forEach((note, index) => {
    const target = hzOfMidi(note) * semitones(expectedSemitones[index] as number);
    // The last half of each note: the pitch tracker and the glide have settled.
    const from = Math.round((index + 0.5) * seconds * SR);
    const to = Math.round((index + 0.95) * seconds * SR);
    const found = peakNear(out, from, to, target);
    expect(Math.abs(found.offsetCents), `note ${note} (formant ${String(formant)})`).toBeLessThan(toleranceCents);
    // (Keeping formants lowers the fundamental of a shifted voice: its tone colour stays where it was, so a fundamental
    // moved off the voice's own loud region is quieter.)
    expect(found.level, `note ${note} sounds`).toBeGreaterThan(formant ? 0.004 : 0.02);
  });
}

describe('HarmonizerKernel: intervals in the key', () => {
  // A minor: A B C D E F G. Sung A3 B3 C4 D4 (MIDI 57 59 60 62).
  const sung = [57, 59, 60, 62];
  const aMinor: Params = { key: 'A', scale: 'minor' };

  for (const formant of [false, true]) {
    it(`a third above in A minor (A→C, B→D, C→E, D→F), keep formants ${String(formant)}`, () => {
      expectIntervals(sung, [3, 3, 4, 3], { ...aMinor, interval1: 2 }, 8, formant);
    });

    it(`a fifth above in A minor (A→E, B→F, C→G, D→A), keep formants ${String(formant)}`, () => {
      expectIntervals(sung, [7, 6, 7, 7], { ...aMinor, interval1: 4 }, 8, formant);
    });

    it(`an octave below is exactly half the frequency, keep formants ${String(formant)}`, () => {
      expectIntervals(sung, [-12, -12, -12, -12], { ...aMinor, interval1: -7 }, 5, formant);
    });
  }

  it('a sixth above and a third below also land on the scale', () => {
    expectIntervals(sung, [8, 8, 9, 9], { ...aMinor, interval1: 5 }, 8, false); // A→F, B→G, C→A, D→B
    expectIntervals(sung, [-4, -4, -3, -3], { ...aMinor, interval1: -2 }, 8, false); // A→F, B→G, C→A, D→B, all below
  });

  it('a fixed shift ignores the key: interval 0 plus 7 semitones is a perfect fifth even on a note outside the scale', () => {
    expectIntervals([58, 61], [7, 7], { ...aMinor, interval1: 0, semitones1: 7 }, 8, false);
  });

  it('a sung note off the scale is matched to the nearest scale note; snap to key puts the voice dead on the scale note', () => {
    // 20 cents sharp of A3: relative mode keeps the 20 cents, snap mode removes them.
    const sharpA = 220 * Math.pow(2, 20 / 1200);
    const run = (tighten: number) =>
      runEffect(HarmonizerKernel, harmonizerParams, sine(sharpA), SR, {
        params: { ...SINGLE_VOICE, key: 'A', scale: 'minor', interval1: 2, tighten },
      })[0];
    const cTarget = 220 * semitones(3);
    const relative = peakNear(run(0), Math.round(0.6 * SR), Math.round(0.95 * SR), cTarget);
    const snapped = peakNear(run(1), Math.round(0.6 * SR), Math.round(0.95 * SR), cTarget);
    expect(relative.offsetCents).toBeGreaterThan(12);
    expect(relative.offsetCents).toBeLessThan(28);
    expect(Math.abs(snapped.offsetCents)).toBeLessThan(6);
  });

  it('follows a slide: the voice stays an interval from the live pitch', () => {
    // A slow glide up 60 cents from A3 around a held scale note: the voice's pitch is the same 3 semitones above.
    const glide = sine((frame) => 220 * Math.pow(2, (Math.min(1, frame / SR) * 30) / 1200));
    const out = runEffect(HarmonizerKernel, harmonizerParams, glide, 2 * SR, {
      params: { ...SINGLE_VOICE, key: 'A', scale: 'minor', interval1: 2 },
    })[0];
    const target = 220 * semitones(3) * Math.pow(2, 30 / 1200);
    const found = peakNear(out, Math.round(1.5 * SR), Math.round(1.95 * SR), target);
    expect(Math.abs(found.offsetCents)).toBeLessThan(8);
  });

  it('the voice count and each voice’s level and pan decide what is heard', () => {
    const run = (params: Params) =>
      runEffect(HarmonizerKernel, harmonizerParams, sine(220), SR, {
        params: { key: 'A', scale: 'minor', mix: 1, humanize: 0, formant: false, ...params },
      });
    const from = Math.round(0.6 * SR);
    const to = Math.round(0.95 * SR);
    // Voice 1 (a third, 3 st) hard left, voice 2 (a fifth, 7 st) hard right, voice 3 off.
    const [left, right] = run({ voices: 2, interval1: 2, level1: 0, pan1: -1, interval2: 4, level2: 0, pan2: 1 });
    expect(levelAt(left, from, to, 220 * semitones(3))).toBeGreaterThan(0.05);
    expect(levelAt(left, from, to, 220 * semitones(7))).toBeLessThan(0.01);
    expect(levelAt(right, from, to, 220 * semitones(7))).toBeGreaterThan(0.05);
    expect(levelAt(right, from, to, 220 * semitones(3))).toBeLessThan(0.01);
    // One voice only: the second is silent.
    const [oneVoiceLeft, oneVoiceRight] = run({ voices: 1, interval1: 2, pan1: 0, interval2: 4, pan2: 0 });
    expect(levelAt(oneVoiceLeft, from, to, 220 * semitones(7))).toBeLessThan(0.01);
    expect(levelAt(oneVoiceRight, from, to, 220 * semitones(7))).toBeLessThan(0.01);
    // A quieter voice is quieter by its level.
    const [quiet] = run({ voices: 1, interval1: 2, pan1: -1, level1: -12 });
    const [loud] = run({ voices: 1, interval1: 2, pan1: -1, level1: 0 });
    const ratioDb = 20 * Math.log10(levelAt(quiet, from, to, 220 * semitones(3)) / levelAt(loud, from, to, 220 * semitones(3)));
    expect(ratioDb).toBeGreaterThan(-12.6);
    expect(ratioDb).toBeLessThan(-11.4);
  });

  it('works on a voice-like harmonic tone as well as on a sine', () => {
    const out = runEffect(HarmonizerKernel, harmonizerParams, voiceAt(220), SR, {
      params: { ...SINGLE_VOICE, key: 'A', scale: 'minor', interval1: 2, formant: true },
    })[0];
    const found = peakNear(out, Math.round(0.6 * SR), Math.round(0.95 * SR), 220 * semitones(3));
    expect(Math.abs(found.offsetCents)).toBeLessThan(8);
  });
});

describe('HarmonizerKernel: guide notes', () => {
  const held = (...keys: number[]) => keys.map((key) => ({ frame: 0, key }));
  const NOTES_MODE: Params = { source: 'notes', mix: 1, humanize: 0, formant: false };
  /** Each voice hard to one side or centre-less so the three can be told apart: voice 1 left, 2 right, 3 both. */
  const SPLIT: Params = { ...NOTES_MODE, voices: 3, level1: 0, level2: 0, level3: 0, pan1: -1, pan2: 1, pan3: 0 };

  it('voice 1 sings the held note nearest the singer', () => {
    // 220 Hz (A3) with E4 and G4 held: E4 is the nearest.
    const out = runEffect(HarmonizerKernel, harmonizerParams, sine(220), SR, {
      params: { ...NOTES_MODE, voices: 1, pan1: 0, level1: 0 },
      notes: held(64, 67),
    })[0];
    const found = peakNear(out, Math.round(0.6 * SR), Math.round(0.95 * SR), hzOfMidi(64));
    expect(Math.abs(found.offsetCents)).toBeLessThan(8);
    expect(found.level).toBeGreaterThan(0.05);
  });

  it('a chord is a harmony: voice 2 is the next note above voice 1, voice 3 the next below', () => {
    // Sung 220 Hz (A3, 57) over a held C major triad E4 G4 C5 (64 67 72): voice 1 = E4, voice 2 = G4 (right), voice 3 = the
    // chord's top note an octave down while none is lower... here nothing is below E4, so C4 (72 - 12 = 60, then below 64).
    const [left, right] = runEffect(HarmonizerKernel, harmonizerParams, sine(220), SR, {
      params: SPLIT,
      notes: held(64, 67, 72),
    });
    const from = Math.round(0.6 * SR);
    const to = Math.round(0.95 * SR);
    // Left carries voice 1 (E4) and voice 3 (centre); right carries voice 2 (G4) and voice 3.
    expect(Math.abs(peakNear(left, from, to, hzOfMidi(64)).offsetCents)).toBeLessThan(8);
    expect(levelAt(left, from, to, hzOfMidi(64))).toBeGreaterThan(0.05);
    expect(Math.abs(peakNear(right, from, to, hzOfMidi(67)).offsetCents)).toBeLessThan(8);
    expect(levelAt(right, from, to, hzOfMidi(67))).toBeGreaterThan(0.05);
    // Voice 3: nothing held is below E4, so it takes the top note (C5) moved down whole octaves to C4.
    expect(Math.abs(peakNear(left, from, to, hzOfMidi(60)).offsetCents)).toBeLessThan(8);
    expect(levelAt(left, from, to, hzOfMidi(60))).toBeGreaterThan(0.03);
    expect(levelAt(right, from, to, hzOfMidi(60))).toBeGreaterThan(0.03);
  });

  it('follows the chord as it changes, and is silent while nothing is held', () => {
    const input = sine(220);
    const frames = 3 * SR;
    const out = runEffect(HarmonizerKernel, harmonizerParams, input, frames, {
      params: { ...NOTES_MODE, voices: 1, pan1: 0, level1: 0 },
      notes: [
        { frame: 0, key: 64 },
        { frame: SR, key: 64, off: true },
        { frame: SR + 5000, key: 62 },
        { frame: Math.round(2 * SR), key: 62, off: true },
      ],
    })[0];
    // E4 held: sounds. Gap between: silent. D4 held: sounds at D4. Released: silent.
    expect(peakNear(out, Math.round(0.5 * SR), Math.round(0.9 * SR), hzOfMidi(64)).level).toBeGreaterThan(0.05);
    expect(Math.abs(peakNear(out, Math.round(0.5 * SR), Math.round(0.9 * SR), hzOfMidi(64)).offsetCents)).toBeLessThan(8);
    let quiet = 0;
    for (let i = SR + 1500; i < SR + 4500; i++) quiet = Math.max(quiet, Math.abs(out[i] as number));
    expect(quiet).toBeLessThan(0.01);
    expect(Math.abs(peakNear(out, Math.round(1.5 * SR), Math.round(1.9 * SR), hzOfMidi(62)).offsetCents)).toBeLessThan(8);
    let after = 0;
    for (let i = Math.round(2.4 * SR); i < frames; i++) after = Math.max(after, Math.abs(out[i] as number));
    expect(after).toBeLessThan(0.01);
  });

  it('the key and scale are ignored in Played notes mode, and the notes in Key and scale mode', () => {
    const notesIgnoresKey = runEffect(HarmonizerKernel, harmonizerParams, sine(220), SR, {
      params: { ...NOTES_MODE, voices: 1, pan1: 0, level1: 0, key: 'F#', scale: 'blues' },
      notes: held(64),
    })[0];
    expect(Math.abs(peakNear(notesIgnoresKey, Math.round(0.6 * SR), Math.round(0.95 * SR), hzOfMidi(64)).offsetCents)).toBeLessThan(8);
    const scaleIgnoresNotes = runEffect(HarmonizerKernel, harmonizerParams, sine(220), SR, {
      params: { ...SINGLE_VOICE, source: 'scale', key: 'A', scale: 'minor', interval1: 2, formant: false },
      notes: held(75),
    })[0];
    expect(Math.abs(peakNear(scaleIgnoresNotes, Math.round(0.6 * SR), Math.round(0.95 * SR), 220 * semitones(3)).offsetCents)).toBeLessThan(8);
  });
});

describe('HarmonizerKernel: timing and mix', () => {
  it('reports its latency in whole frames at every sample rate (the definition uses the same function)', () => {
    const kernel = new HarmonizerKernel({ sampleRate: SR, state: undefined, post: () => {}, rand: () => 0.5 });
    expect(kernel.latency).toBe(LATENCY);
    const slower = new HarmonizerKernel({ sampleRate: 44100, state: undefined, post: () => {}, rand: () => 0.5 });
    expect(slower.latency).toBe(harmonizerLatencyFrames(44100));
  });

  it('with Mix at 0 an impulse comes out exactly LATENCY frames late, in both channels', () => {
    const impulse: TestSignal = (frame) => (frame === 0 ? 1 : 0);
    const out = runEffect(HarmonizerKernel, harmonizerParams, impulse, 4000, { params: { mix: 0 } });
    for (const channel of out) {
      expect(channel[LATENCY]).toBeCloseTo(1, 6);
      for (let i = 0; i < channel.length; i++) if (i !== LATENCY) expect(Math.abs(channel[i] as number)).toBeLessThan(1e-6);
    }
  });

  it('a voice shifted by nothing is the input at the same delay as the dry path (they add, they do not comb)', () => {
    const x = (frame: number) => 0.4 * Math.sin((2 * Math.PI * 300 * frame) / SR);
    const out = runEffect(HarmonizerKernel, harmonizerParams, x, SR, {
      params: { ...SINGLE_VOICE, interval1: 0, semitones1: 0, formant: false },
    })[0];
    for (let i = Math.round(0.5 * SR); i < SR; i += 11) expect(out[i]).toBeCloseTo(0.707 * x(i - LATENCY), 2);
    const withFormants = runEffect(HarmonizerKernel, harmonizerParams, x, SR, {
      params: { ...SINGLE_VOICE, interval1: 0, semitones1: 0, formant: true },
    })[0];
    let worst = 0;
    for (let i = Math.round(0.5 * SR); i < SR; i++) worst = Math.max(worst, Math.abs((withFormants[i] as number) - 0.707 * x(i - LATENCY)));
    expect(worst).toBeLessThan(0.03);
  });

  it('Mix keeps the original at full level up to 50 % and brings the voices up to full level', () => {
    const run = (mix: number) =>
      runEffect(HarmonizerKernel, harmonizerParams, sine(220), SR, {
        params: { ...SINGLE_VOICE, mix, key: 'A', scale: 'minor', interval1: 2, formant: false },
      })[0];
    const from = Math.round(0.6 * SR);
    const to = Math.round(0.95 * SR);
    const original = (mix: number) => levelAt(run(mix), from, to, 220);
    const voice = (mix: number) => levelAt(run(mix), from, to, 220 * semitones(3));
    expect(voice(0)).toBeLessThan(0.002);
    expect(original(0.5)).toBeCloseTo(original(0), 2);
    expect(voice(0.25)).toBeCloseTo(0.5 * voice(0.5), 2);
    expect(voice(1)).toBeCloseTo(voice(0.5), 2);
    expect(original(1)).toBeLessThan(0.002);
  });
});

describe('HarmonizerKernel: Humanize', () => {
  it('drifts each voice slowly by at most the amount set, differently per voice, and 0 is exact', () => {
    const pitchTrack = (humanize: number, interval: number) => {
      const out = runEffect(HarmonizerKernel, harmonizerParams, sine(220), 6 * SR, {
        params: { ...SINGLE_VOICE, key: 'A', scale: 'minor', interval1: interval, humanize, formant: false },
      })[0];
      const track: number[] = [];
      for (let at = Math.round(0.6 * SR); at + 9600 <= out.length; at += 9600)
        track.push(peakNear(out, at, at + 9600, 220 * semitones(interval === 2 ? 3 : 7)).offsetCents);
      return track;
    };
    const exact = pitchTrack(0, 2);
    expect(Math.max(...exact.map(Math.abs))).toBeLessThan(3);
    const drifting = pitchTrack(20, 2);
    expect(Math.max(...drifting.map(Math.abs))).toBeLessThan(26);
    expect(Math.max(...drifting) - Math.min(...drifting)).toBeGreaterThan(8);
    expect(pitchTrack(20, 2)).toEqual(drifting);
  });
});

describe('HarmonizerKernel: robustness', () => {
  function noise(seed: number): TestSignal {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2147483648 - 1;
    };
  }

  it('stays finite and bounded at the extremes of every parameter, on a voice and on noise', () => {
    const extremeCases: Params[] = [
      { voices: 3, interval1: 7, interval2: -7, interval3: 7, semitones1: 12, semitones2: -12, semitones3: 12, level1: 6, level2: 6, level3: 6, humanize: 30, tighten: 1, mix: 1, formant: true },
      { voices: 3, interval1: -7, interval2: -7, interval3: -7, semitones1: -12, semitones2: -12, semitones3: -12, pan1: -1, pan2: 1, mix: 0.5, formant: false, range: 'low' },
      { voices: 3, source: 'notes', range: 'high', formant: true, mix: 1, level1: 6, level2: 6, level3: 6 },
      { voices: 1, scale: 'chromatic', key: 'B', range: 'low', humanize: 0, mix: 0 },
      { voices: 3, scale: 'hirajoshi', key: 'F#', interval1: 7, interval2: 3, interval3: -5, formant: true },
    ];
    const chord = [{ frame: 0, key: 12 }, { frame: 0, key: 127 }, { frame: 5000, key: 64 }, { frame: 9000, key: 64, off: true }];
    for (const [index, params] of extremeCases.entries()) {
      for (const [name, input] of [['voice', voiceAt((f) => 110 + 400 * Math.sin(f / 9000), 0.9)], ['noise', noise(3)]] as const) {
        const out = runEffect(HarmonizerKernel, harmonizerParams, input, SR, { params, notes: chord });
        for (const channel of out) {
          let peak = 0;
          for (let i = 0; i < channel.length; i++) {
            const value = channel[i] as number;
            expect(Number.isFinite(value), `case ${index} ${name} frame ${i}`).toBe(true);
            peak = Math.max(peak, Math.abs(value));
          }
          expect(peak, `case ${index} ${name}`).toBeLessThan(8);
        }
      }
    }
  });

  it('is deterministic: the same input and settings give the same samples', () => {
    const run = () =>
      runEffect(HarmonizerKernel, harmonizerParams, voiceAt((f) => 200 + 30 * Math.sin(f / 7000)), SR, {
        params: { voices: 3, humanize: 15, formant: true, interval3: -5 },
      });
    const [a, b] = [run(), run()];
    expect(a[0]).toEqual(b[0]);
    expect(a[1]).toEqual(b[1]);
  });

  it('every preset sets only real params and runs', () => {
    expect(harmonizer.presets?.map((preset) => preset.name)).toEqual(['Thirds above', 'Choir stack', 'Octave down', 'Fifth and octave up', 'Gospel 3-part']);
    for (const preset of harmonizer.presets ?? []) {
      const out = runEffect(HarmonizerKernel, harmonizerParams, voiceAt(220), SR / 2, { params: preset.params as Params })[0];
      expect(out.every(Number.isFinite), preset.name).toBe(true);
    }
  });

  it('its scales are the SDK’s SCALES (ids, labels, intervals, order)', () => {
    expect(HARMONIZER_SCALES.map((s) => s.id)).toEqual(SCALES.map((s) => s.id));
    expect(HARMONIZER_SCALES.map((s) => s.label)).toEqual(SCALES.map((s) => s.label));
    expect(HARMONIZER_SCALES.map((s) => [...s.intervals])).toEqual(SCALES.map((s) => [...s.intervals]));
    expect(harmonizerParams.scale.options).toEqual(SCALES.map((s) => s.id));
  });
});

describe('harmony maths', () => {
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const MINOR = [0, 2, 3, 5, 7, 8, 10];

  it('moves by scale steps: thirds, fifths and octaves in C major and A minor', () => {
    expect(scaleStepSemitones(60, 0, MAJOR, 2)).toBe(4); // C → E
    expect(scaleStepSemitones(64, 0, MAJOR, 2)).toBe(3); // E → G
    expect(scaleStepSemitones(60, 0, MAJOR, 4)).toBe(7); // C → G
    expect(scaleStepSemitones(59, 0, MAJOR, 4)).toBe(6); // B → F
    expect(scaleStepSemitones(60, 0, MAJOR, -7)).toBe(-12);
    expect(scaleStepSemitones(60, 0, MAJOR, 7)).toBe(12);
    expect(scaleStepSemitones(60, 0, MAJOR, -2)).toBe(-3); // C → A below
    expect(scaleStepSemitones(57, 9, MINOR, 2)).toBe(3); // A → C
    expect(scaleStepSemitones(62, 9, MINOR, 2)).toBe(3); // D → F
    expect(scaleStepSemitones(62, 0, [0, 2, 4, 7, 9], 2)).toBe(5); // pentatonic: D → G (two notes up)
  });

  it('finds the nearest note of a scale, with hysteresis', () => {
    const cMajor = scaleMaskOf(MAJOR);
    expect(nearestScaleNote(61.4, 0, cMajor, -1)).toBe(62);
    expect(nearestScaleNote(61.05, 0, cMajor, 60)).toBe(60);
    expect(nearestScaleNote(59.9, 0, scaleMaskOf([0, 2, 3, 5, 7, 8, 10]), -1)).toBe(60);
  });

  it('picks held notes: nearest, then the next above and below, wrapping by octaves', () => {
    const keys = Int16Array.from([64, 67, 72]);
    expect(nearestHeldKey(keys, 3, 57, -1)).toBe(64);
    expect(nearestHeldKey(keys, 3, 70, -1)).toBe(72);
    expect(nearestHeldKey(keys, 0, 70, -1)).toBe(-1);
    expect(heldKeyAbove(keys, 3, 64)).toBe(67);
    expect(heldKeyAbove(keys, 3, 72)).toBe(76); // lowest (64) moved up an octave
    expect(heldKeyBelow(keys, 3, 67)).toBe(64);
    expect(heldKeyBelow(keys, 3, 64)).toBe(60); // highest (72) moved down an octave
    expect(heldKeyAbove(keys, 0, 64)).toBe(-1);
    expect(heldKeyBelow(keys, 0, 64)).toBe(-1);
    const single = Int16Array.from([60]);
    expect(heldKeyAbove(single, 1, 60)).toBe(72);
    expect(heldKeyBelow(single, 1, 60)).toBe(48);
    expect(foldNearPitch(36, 60)).toBe(48);
    expect(foldNearPitch(90, 60)).toBe(66);
    expect(foldNearPitch(65, 60)).toBe(65);
  });
});

describe('HarmonizerKernel: audio-thread rules', () => {
  /** The body of a method of a source file, comments removed. */
  function body(text: string, name: string): string {
    const start = new RegExp(`^  (?:override |private )*(?:get )?${name}\\(`, 'm').exec(text);
    expect(start, `method ${name} exists`).not.toBeNull();
    const from = (start as RegExpExecArray).index;
    const end = text.indexOf('\n  }\n', from);
    return text
      .slice(from, end + 4)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  const FORBIDDEN: [string, RegExp][] = [
    ['new', /\bnew\s/],
    ['array literal', /(^|[=(,:?]\s*)\[/m],
    ['object literal', /(=|\(|,|return)\s*\{/],
    ['closure', /=>|\bfunction\b/],
    ['spread', /\.\.\./],
    ['template string', /`/],
    ['copying call', /\.(map|filter|slice|concat|forEach|reduce|splice|from)\(/],
    ['for-of loop', /\bfor\s*\(\s*(const|let)\s+\w+\s+of\b/],
  ];

  it('the audio-thread methods allocate nothing: no new, literals, closures, spreads, iterators or strings', () => {
    const checked: [string, string[]][] = [
      [
        source,
        [
          'process',
          'readBlockSettings',
          'readVoice',
          'listen',
          'retarget',
          'noteUnpitched',
          'tellVoicesPitch',
          'smoothPitch',
          'advanceDrift',
          'driftOf',
          'pickNotes',
          'pickScaleNotes',
          'pickGuideNotes',
          'guideKeyFor',
          'noteOn',
          'noteOff',
          'allNotesOff',
        ],
      ],
      [voiceSource, ['setPitch', 'setGoalCents', 'setTargetGains', 'render', 'fallSilent']],
      [shifterSource, ['next', 'spliceSound', 'skipSplice', 'startSplice', 'grains', 'spawnGrainsDue', 'startGrain', 'freeGrainSlot', 'stopGrains', 'setPitch']],
    ];
    for (const [text, methods] of checked) {
      for (const method of methods) {
        const code = body(text, method);
        for (const [what, pattern] of FORBIDDEN) expect(pattern.test(code), `${method}() has a ${what}`).toBe(false);
      }
    }
    for (const fn of ['scaleMaskOf', 'nearestScaleNote', 'scaleStepSemitones', 'nearestHeldKey', 'heldKeyAbove', 'heldKeyBelow', 'foldNearPitch']) {
      const match = new RegExp(`export function ${fn}\\([\\s\\S]*?\\n\\}\\n`).exec(harmonySource);
      expect(match, fn).not.toBeNull();
      // (Without the doc comment and the signature line, whose `function` is not a closure.)
      const code = (match as RegExpExecArray)[0].replace(/\/\/.*$/gm, '').replace(/^export function [^\n]*\n/, '');
      for (const [what, pattern] of FORBIDDEN) expect(pattern.test(code), `${fn}() has a ${what}`).toBe(false);
    }
  });

  it('keeps nothing between blocks that grows: the heap is the same after a long run (all voices, formants, guide notes)', () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const x = voiceAt((f) => 220 * Math.pow(2, (25 * Math.sin(f / 16000)) / 1200));
    const cases: Array<[string, Params, boolean]> = [
      ['key, 3 voices, formants', { voices: 3, formant: true, humanize: 12, tighten: 0.5, key: 'D', scale: 'major' }, false],
      ['key, 2 voices, plain', { formant: false }, false],
      ['notes', { source: 'notes', voices: 3, formant: true }, true],
    ];
    const block = 128;
    const inL = Float32Array.from({ length: block * 4 }, (_, i) => x(i, 0));
    const inputs = [0, 1, 2, 3].map((b) => [inL.subarray(b * block, (b + 1) * block), inL.subarray(b * block, (b + 1) * block)]);
    const outputs = [new Float32Array(block), new Float32Array(block)];
    for (const [name, params, notes] of cases) {
      const kernel = new HarmonizerKernel({ sampleRate: SR, state: undefined, post: () => {}, rand: () => 0.3 });
      const pb = paramBlock(harmonizerParams, params);
      if (notes) {
        kernel.noteOn(64, 0.8, 1);
        kernel.noteOn(67, 0.8, 2);
      }
      const run = (blocks: number) => {
        for (let b = 0; b < blocks; b++) {
          kernel.process(inputs[b & 3] as Float32Array[], outputs, block, pb);
          if (notes && b % 500 === 0) {
            kernel.noteOff(1);
            kernel.noteOn(64, 0.8, 1);
          }
        }
      };
      run(2000);
      gc();
      const before = process.memoryUsage().heapUsed;
      run(30000);
      gc();
      const kept = process.memoryUsage().heapUsed - before;
      expect(kept, `${name}: heap kept after 30000 blocks`).toBeLessThan(150_000);
    }
  });

  it('declares one voice per voice param group', () => {
    expect(MAX_VOICES).toBe(3);
    for (let voice = 1; voice <= MAX_VOICES; voice++)
      for (const name of ['interval', 'semitones', 'level', 'pan']) expect(harmonizerParams).toHaveProperty(`${name}${voice}`);
  });
});
