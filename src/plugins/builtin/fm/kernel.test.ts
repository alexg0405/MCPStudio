import { describe, expect, it } from 'vitest';
import type { ParamValue } from '@agstudio/sdk';
import { FM_ALGORITHMS } from '@agstudio/sdk/worklet';
import { paramBlock, peak, renderInstrument, rms, testHost } from '@agstudio/sdk/testing';
import { FmKernel } from './kernel';
import { fmParams, opParam } from './params';

const SR = 48000;
const KEY = 57; // 220 Hz
/** Ratio and fine per operator: frequencies 220, 301.4, 488.4 and 851.4 Hz, so every sum is unique. */
const TUNING = [
  [1, 0],
  [1, 0.37],
  [2, 0.11],
  [3, 0.29],
] as const;
const FREQ = TUNING.map(([r, f]) => 220 * r * (1 + f));

/** Steady tones: instant attack, full sustain, no velocity response; `levels` per operator (1–4). */
function steady(algorithm: number, levels: number[], extra: Record<string, ParamValue> = {}) {
  const values: Record<string, ParamValue> = { algorithm: String(algorithm + 1), level: 0, ...extra };
  for (let o = 0; o < 4; o++) {
    const id = opParam(o + 1);
    values[id.ratio] = TUNING[o]![0];
    values[id.fine] = TUNING[o]![1];
    values[id.level] = levels[o] ?? 0;
    values[id.attack] = 0.001;
    values[id.decay] = 10;
    values[id.sustain] = 1;
    values[id.velocity] = 0;
  }
  return values;
}

function note(values: Record<string, ParamValue>, seconds = 0.6, key = KEY, events: [number, () => void][] = []) {
  const k = new FmKernel(testHost(SR));
  return renderInstrument(k, Math.round(seconds * SR), paramBlock(fmParams, values), [
    { frame: 0, run: () => k.noteOn(key, 1, 1, 0, 0) },
    ...events.map(([frame, run]) => ({ frame, run: () => run.call(k) })),
  ])[0];
}

/** Level (dB) of the frequency `hz` over 0.1–0.6 s (Hann-windowed Goertzel). */
function levelAt(x: Float32Array, hz: number): number {
  const a = Math.round(0.1 * SR);
  const n = Math.min(x.length, Math.round(0.6 * SR)) - a;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const ph = (2 * Math.PI * hz * i) / SR;
    re += (x[a + i] as number) * w * Math.cos(ph);
    im -= (x[a + i] as number) * w * Math.sin(ph);
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / (n / 2) + 1e-12);
}

describe('FM kernel', () => {
  FM_ALGORITHMS.forEach((alg, a) => {
    describe(`algorithm ${a + 1} (${alg.label})`, () => {
      it('plays each operator you hear as a sine at its frequency, and none of the others', () => {
        for (let o = 0; o < 4; o++) {
          const levels = [0, 0, 0, 0];
          levels[o] = 0.7;
          const x = note(steady(a, levels));
          if (alg.carriers.includes(o)) {
            expect(levelAt(x, FREQ[o]!), `op ${o + 1}`).toBeGreaterThan(-30);
            for (let other = 0; other < 4; other++)
              if (other !== o) expect(levelAt(x, FREQ[other]!)).toBeLessThan(levelAt(x, FREQ[o]!) - 60);
          } else expect(peak(x), `op ${o + 1} is a modulator here`).toBe(0);
        }
      });

      it('makes sidebands on a heard operator only where an arrow says so', () => {
        for (const c of alg.carriers)
          for (let s = 0; s < 4; s++) {
            if (s === c) continue;
            const levels = [0, 0, 0, 0];
            levels[c] = 0.7;
            levels[s] = 0.6;
            const x = note(steady(a, levels));
            const sideband = levelAt(x, FREQ[c]! + FREQ[s]!) - levelAt(x, FREQ[c]!);
            if (alg.modulators[c]!.includes(s)) expect(sideband, `${s + 1}→${c + 1}`).toBeGreaterThan(-30);
            else expect(sideband, `no ${s + 1}→${c + 1}`).toBeLessThan(-80);
          }
      });

      it('lets a modulator reach what you hear only through the operator it feeds', () => {
        alg.modulators.forEach((sources, t) => {
          if (alg.carriers.includes(t)) return;
          // The path from t down to a heard operator.
          const path = [t];
          for (let at = t; !alg.carriers.includes(at);) {
            at = alg.modulators.findIndex((m) => m.includes(at));
            path.push(at);
          }
          for (const s of sources) {
            const levels = [0, 0, 0, 0];
            for (const o of path) levels[o] = 0.6;
            const without = note(steady(a, levels));
            levels[s] = 0.6;
            const withS = note(steady(a, levels));
            expect(rms(withS.map((v, i) => v - (without[i] as number)))).toBeGreaterThan(1e-3);
            // With the operator it feeds silenced, it changes nothing at all.
            levels[t] = 0;
            const cut = note(steady(a, levels));
            levels[s] = 0;
            expect(cut, `${s + 1}→${t + 1} only`).toEqual(note(steady(a, levels)));
          }
        });
      });
    });
  });

  it('follows the key, the note’s fine pitch and the channel pitch', () => {
    const x = note(steady(7, [0.7, 0, 0, 0]), 0.6, 69);
    expect(levelAt(x, 440)).toBeGreaterThan(-30);
    const k = new FmKernel(testHost(SR));
    k.pitch = new Float32Array([1200]);
    const [up] = renderInstrument(k, Math.round(0.6 * SR), paramBlock(fmParams, steady(7, [0.7, 0, 0, 0])), [
      { frame: 0, run: () => k.noteOn(69, 1, 1, 0, -100) },
    ]);
    // +1200 ct channel pitch, −100 ct fine: 11 semitones up.
    expect(levelAt(up, 440 * Math.pow(2, 11 / 12))).toBeGreaterThan(-30);
  });

  it('envelopes: attack, sustain, release, and the voice ends after its release', () => {
    const values = steady(7, [0.7, 0, 0, 0]);
    values[opParam(1).attack] = 0.1;
    values[opParam(1).release] = 0.2;
    const k = new FmKernel(testHost(SR));
    const [x] = renderInstrument(k, SR, paramBlock(fmParams, values), [
      { frame: 0, run: () => k.noteOn(KEY, 1, 1, 0, 0) },
      { frame: SR / 2, run: () => k.noteOff(1, KEY, 0.5) },
    ]);
    expect(rms(x, 0, 1200)).toBeLessThan(rms(x, 9600, 12000) / 3); // still rising in the first 25 ms
    expect(rms(x, 9600, 12000)).toBeCloseTo(rms(x, 19200, 21600), 2); // sustaining
    expect(rms(x, SR / 2 + 0.2 * SR, SR)).toBeLessThan(rms(x, 9600, 12000) / 300); // released
    expect(peak(x, SR - 4800, SR)).toBe(0);
  });

  it('velocity sensitivity scales an operator, and feedback brightens operator 4', () => {
    const values = steady(7, [0.7, 0, 0, 0]);
    values[opParam(1).velocity] = 1;
    const k = new FmKernel(testHost(SR));
    const [soft] = renderInstrument(k, SR / 2, paramBlock(fmParams, values), [
      { frame: 0, run: () => k.noteOn(KEY, 0.5, 1, 0, 0) },
    ]);
    const loud = note(values, 0.5);
    expect(rms(soft, 4800) / rms(loud, 4800)).toBeCloseTo(0.5, 2);
    const plain = note(steady(7, [0, 0, 0, 0.7]));
    const buzzy = note(steady(7, [0, 0, 0, 0.7], { feedback: 1 }));
    expect(levelAt(buzzy, FREQ[3]! * 2) - levelAt(plain, FREQ[3]! * 2)).toBeGreaterThan(30);
  });

  it('the tone filter darkens, and the mod wheel brightens', () => {
    const bright = steady(0, [0.8, 0.8, 0, 0]);
    const open = note(bright);
    const dark = note({ ...bright, cutoff: 200 });
    const h = FREQ[0]! + 2 * FREQ[1]!;
    expect(levelAt(dark, h)).toBeLessThan(levelAt(open, h) - 10);
    const k = new FmKernel(testHost(SR));
    k.controlChange(1, 1);
    const [wheel] = renderInstrument(k, Math.round(0.6 * SR), paramBlock(fmParams, steady(0, [0.8, 0.4, 0, 0])), [
      { frame: 0, run: () => k.noteOn(KEY, 1, 1, 0, 0) },
    ]);
    const still = note(steady(0, [0.8, 0.4, 0, 0]));
    expect(levelAt(wheel, h)).toBeGreaterThan(levelAt(still, h) + 6);
  });

  it('a note released before it starts is cancelled, and a hard all-notes-off silences at once', () => {
    const k = new FmKernel(testHost(SR));
    const [x] = renderInstrument(k, SR / 4, paramBlock(fmParams, steady(7, [0.7, 0, 0, 0])), [
      { frame: 0, run: () => k.noteOn(KEY, 1, 1, 0, 0) },
      { frame: 0, run: () => k.noteOff(1, KEY, 0.5) },
    ]);
    expect(peak(x)).toBe(0);
    const k2 = new FmKernel(testHost(SR));
    const [y] = renderInstrument(k2, SR / 2, paramBlock(fmParams, steady(7, [0.7, 0, 0, 0])), [
      { frame: 0, run: () => k2.noteOn(KEY, 1, 1, 0, 0) },
      { frame: 4800, run: () => k2.allNotesOff(true) },
    ]);
    expect(peak(y, 4800 + 16)).toBe(0);
  });
});
