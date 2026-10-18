import { describe, expect, it } from 'vitest';
import type { ParamValue } from '@agstudio/sdk';
import {
  paramBlock,
  peak,
  renderInstrument,
  rms,
  testHost,
  testTransport,
  type KernelEvent,
} from '@agstudio/sdk/testing';
import { WavetableKernel } from './kernel';
import { FACTORY_TABLES, TABLE_OPTIONS, USER_TABLE, wavetableParams } from './params';
import { factoryBank, TABLES } from './tables';

const SR = 48000;
const bank = factoryBank();

function kernel() {
  const k = new WavetableKernel(testHost(SR, 3));
  k.useBank(bank);
  return k;
}

type Values = Record<string, ParamValue>;
/** A plain patch for measurements: no velocity response, key tracking or filter colour. */
const PLAIN: Values = { velocity: 0, keyTrack: 0, cutoff: 20000, resonance: 0 };

function play(
  values: Values,
  notes: [frame: number, key: number, offFrame?: number, velocity?: number][],
  seconds = 1,
  k = kernel(),
  extra: KernelEvent[] = [],
) {
  const events: KernelEvent[] = [...extra];
  notes.forEach(([frame, key, off, vel], i) => {
    events.push({ frame, run: () => k.noteOn(key, vel ?? 1, i + 1, 0, 0) });
    if (off !== undefined) events.push({ frame: off, run: () => k.noteOff(i + 1, key, 0.5) });
  });
  return renderInstrument(k, Math.round(seconds * SR), paramBlock(wavetableParams, { ...PLAIN, ...values }), events);
}

/** Frequency from upward zero crossings over [from, to). */
function freq(x: Float32Array, from: number, to: number): number {
  const c: number[] = [];
  for (let i = Math.max(1, from); i < to; i++) {
    const a = x[i - 1] as number;
    const b = x[i] as number;
    if (a < 0 && b >= 0) c.push(i - 1 + a / (a - b));
  }
  return c.length < 2 ? 0 : ((c.length - 1) * SR) / ((c[c.length - 1] as number) - (c[0] as number));
}

/** Share of energy in the first difference: a rough brightness measure. */
function brightness(x: Float32Array, from: number, to: number): number {
  let e = 0;
  let d = 0;
  for (let i = from + 1; i < to; i++) {
    e += (x[i] as number) ** 2;
    d += ((x[i] as number) - (x[i - 1] as number)) ** 2;
  }
  return d / Math.max(1e-12, e);
}

describe('Wavetable kernel', () => {
  it('builds the tables in the order the table param lists them', () => {
    // The factory tables come first in the same order; the drawn table ('user') is the option after them.
    expect(TABLES.map((t) => t.id)).toEqual(TABLE_OPTIONS.slice(0, FACTORY_TABLES).map(([id]) => id));
    expect(TABLE_OPTIONS[FACTORY_TABLES]?.[0]).toBe(USER_TABLE);
    expect(bank.tables).toBe(FACTORY_TABLES);
  });

  it('plays in tune, follows coarse/fine, the note’s fine pitch and the channel pitch', () => {
    const [x] = play({ osc1Position: 0 }, [[0, 69]]);
    expect(freq(x, 4800, SR)).toBeCloseTo(440, 0);
    const [up] = play({ osc1Position: 0, osc1Coarse: 12, osc1Fine: -100 }, [[0, 69]]);
    expect(freq(up, 4800, SR)).toBeCloseTo(440 * Math.pow(2, 11 / 12), 0);
    const k = kernel();
    k.pitch = new Float32Array([200]);
    const [bent] = renderInstrument(k, SR, paramBlock(wavetableParams, { ...PLAIN, osc1Position: 0 }), [
      { frame: 0, run: () => k.noteOn(69, 1, 1, 0, -100) },
    ]);
    expect(freq(bent, 4800, SR)).toBeCloseTo(440 * Math.pow(2, 1 / 12), 0);
  });

  it('is silent before the bank arrives, and ends after its release', () => {
    const k = new WavetableKernel(testHost(SR));
    expect(peak(play({}, [[0, 60]], 0.2, k)[0])).toBe(0);
    const [x] = play({ ampRelease: 0.1 }, [[0, 60, SR / 4]]);
    expect(rms(x, 2400, 9600)).toBeGreaterThan(0.01);
    // −60 dB after the release time; the voice ends at −100 dB (0.17 s) and is silent from then on.
    expect(peak(x, SR / 4 + 0.1 * SR, SR / 4 + 0.12 * SR)).toBeLessThan(rms(x, 2400, 9600) * 0.003);
    expect(peak(x, SR / 4 + 0.2 * SR, SR)).toBe(0);
  });

  it('the amp envelope shapes the note (attack, sustain)', () => {
    const [x] = play({ ampAttack: 0.2, ampDecay: 0.1, ampSustain: 0.5 }, [[0, 60]]);
    expect(rms(x, 0, 2400)).toBeLessThan(rms(x, 9000, 9600) / 4);
    expect(rms(x, 0.6 * SR, 0.7 * SR) / rms(x, 0.18 * SR, 0.2 * SR)).toBeCloseTo(0.5, 1);
  });

  it('morphs through a table with position: a sine at 0, brighter shapes further on', () => {
    const sine = play({ osc1Position: 0 }, [[0, 57]])[0];
    const square = play({ osc1Position: 1 }, [[0, 57]])[0];
    expect(brightness(square, 4800, SR)).toBeGreaterThan(brightness(sine, 4800, SR) * 5);
  });

  it('unison detunes copies across the stereo field; a single voice in the centre is mono', () => {
    const [l1, r1] = play({ unison: 1 }, [[0, 60]]);
    expect(l1).toEqual(r1);
    const [l, r] = play({ unison: 4, detune: 25, spread: 1 }, [[0, 60]]);
    let diff = 0;
    for (let i = 4800; i < SR; i++) diff += ((l[i] as number) - (r[i] as number)) ** 2;
    expect(Math.sqrt(diff / (SR - 4800))).toBeGreaterThan(0.01);
    // Unison keeps the level about the same.
    expect(rms(l, 4800) / rms(l1, 4800)).toBeGreaterThan(0.5);
    expect(rms(l, 4800) / rms(l1, 4800)).toBeLessThan(2);
  });

  it('the filter darkens, the envelope opens it, and the sub adds lows', () => {
    const open = play({ cutoff: 20000 }, [[0, 57]])[0];
    const dark = play({ cutoff: 300 }, [[0, 57]])[0];
    expect(brightness(dark, 4800, SR)).toBeLessThan(brightness(open, 4800, SR) / 3);
    const env = play({ cutoff: 300, envAmount: 1, modDecay: 0.2 }, [[0, 57]])[0];
    expect(brightness(env, 0, 2400)).toBeGreaterThan(brightness(env, 0.6 * SR, 0.7 * SR) * 2);
    const sub = play({ osc1Level: 0, subLevel: 1 }, [[0, 69]])[0];
    expect(freq(sub, 4800, SR)).toBeCloseTo(220, 0);
    const sub2 = play({ osc1Level: 0, subLevel: 1, subOctave: '2' }, [[0, 69]])[0];
    expect(freq(sub2, 4800, SR)).toBeCloseTo(110, 0);
  });

  it('the mod matrix: an LFO on pitch makes vibrato, the mod wheel opens the filter', () => {
    const [vib] = play({ osc1Position: 0, mod1Source: 'lfo1', mod1Target: 'pitch', mod1Amount: 0.05, lfo1Rate: 4 }, [
      [0, 69],
    ]);
    // ±1.2 semitones at 4 Hz: the pitch differs between the LFO's peak and trough.
    const highs = freq(vib, 0.03 * SR, 0.095 * SR);
    const lows = freq(vib, 0.155 * SR, 0.22 * SR);
    expect(highs / lows).toBeGreaterThan(1.08);
    const k = kernel();
    k.controlChange(1, 1);
    const wheel = play(
      { cutoff: 300, mod1Source: 'modWheel', mod1Target: 'cutoff', mod1Amount: 0.5 },
      [[0, 57]],
      1,
      k,
    )[0];
    const still = play({ cutoff: 300, mod1Source: 'modWheel', mod1Target: 'cutoff', mod1Amount: 0.5 }, [[0, 57]])[0];
    expect(brightness(wheel, 9600, SR)).toBeGreaterThan(brightness(still, 9600, SR) * 3);
  });

  it('a tempo-synced LFO follows the song position: a square on the volume switches on the beat', () => {
    const k = kernel();
    k.transport = testTransport({ bpm: 120, sampleRate: SR }); // a beat every 0.5 s
    const [x] = play(
      {
        lfo1Sync: true,
        lfo1Length: '1/4',
        lfo1Shape: 'square',
        mod1Source: 'lfo1',
        mod1Target: 'amp',
        mod1Amount: -1,
        osc1Position: 0,
      },
      [[0, 69]],
      2,
      k,
    );
    // Square = +1 for the first half of each beat (volume × 0), −1 for the second half (× 2).
    for (let beat = 0; beat < 3; beat++) {
      const t = beat * 0.5 * SR;
      expect(rms(x, t + 0.03 * SR, t + 0.22 * SR), `beat ${beat} first half`).toBeLessThan(1e-3);
      expect(rms(x, t + 0.28 * SR, t + 0.47 * SR), `beat ${beat} second half`).toBeGreaterThan(0.05);
    }
  });

  it('legato slides between overlapping notes without a new attack; mono restarts the envelope', () => {
    // Attack 0.2 s, then down to a 50% sustain: a new attack would climb back to full level.
    const env = { ampAttack: 0.2, ampDecay: 0.05, ampSustain: 0.5, osc1Position: 0 };
    const [x] = play({ ...env, voiceMode: 'legato', glide: 0.2 }, [
      [0, 57, SR],
      [SR / 2, 69, SR],
    ]);
    // Half-way through the glide the pitch is between the two notes.
    const mid = freq(x, SR / 2 + 0.08 * SR, SR / 2 + 0.12 * SR);
    expect(mid).toBeGreaterThan(240);
    expect(mid).toBeLessThan(400);
    expect(freq(x, 0.8 * SR, SR)).toBeCloseTo(440, 0);
    const before = rms(x, SR / 2 - 4800, SR / 2);
    // Legato: no new attack, the level stays at the sustain.
    expect(rms(x, SR / 2 + 0.08 * SR, SR / 2 + 0.1 * SR) / before).toBeCloseTo(1, 1);
    const [m] = play({ ...env, voiceMode: 'mono' }, [
      [0, 57, SR],
      [SR / 2, 69, SR],
    ]);
    // Mono: the attack starts again from where the level was and climbs back up.
    expect(rms(m, SR / 2 + 0.08 * SR, SR / 2 + 0.1 * SR) / before).toBeGreaterThan(1.5);
    expect(rms(m, SR / 2, SR / 2 + 240) / before).toBeLessThan(1.2);
    // Releasing the newer key returns to the one still held (mono note priority).
    const [back] = play({ voiceMode: 'mono', osc1Position: 0 }, [
      [0, 57, SR],
      [SR / 4, 69, SR / 2],
    ]);
    expect(freq(back, 0.7 * SR, SR)).toBeCloseTo(220, 0);
  });

  it('poly mode plays chords, and glide slides each new note from the last one', () => {
    const [chord] = play({ osc1Position: 0 }, [
      [0, 60],
      [0, 64],
      [0, 67],
    ]);
    const [single] = play({ osc1Position: 0 }, [[0, 60]]);
    expect(rms(chord, 4800) / rms(single, 4800)).toBeGreaterThan(1.4);
    const [g] = play({ osc1Position: 0, glide: 0.3 }, [
      [0, 57, SR / 4],
      [SR / 2, 69],
    ]);
    const early = freq(g, SR / 2 + 0.02 * SR, SR / 2 + 0.08 * SR);
    expect(early).toBeLessThan(400);
    expect(freq(g, 0.9 * SR, SR)).toBeCloseTo(440, 0);
  });

  it('a hard all-notes-off silences at once; a cancelled note never sounds', () => {
    const k = kernel();
    const [x] = play({}, [[0, 60]], 0.5, k, [{ frame: 4800, run: () => k.allNotesOff(true) }]);
    expect(peak(x, 4800 + 32)).toBe(0);
    const k2 = kernel();
    const [y] = play({}, [[0, 60, 0]], 0.3, k2);
    expect(peak(y)).toBe(0);
  });
});
