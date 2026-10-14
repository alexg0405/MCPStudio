import { describe, expect, it } from 'vitest';
import type { ParamValue } from '@agstudio/sdk';
import { paramBlock, peak, renderInstrument, rms, testHost } from '@agstudio/sdk/testing';
import { DrumSynthKernel } from './kernel';
import { DRUMS, drumSynthParams } from './params';

const SR = 48000;

function hit(keys: number[], seconds = 1, values: Partial<Record<keyof typeof drumSynthParams, ParamValue>> = {}) {
  const k = new DrumSynthKernel(testHost(SR));
  return renderInstrument(
    k,
    Math.round(seconds * SR),
    paramBlock(drumSynthParams, values),
    keys.map((key, i) => ({ frame: i * 4800, run: () => k.noteOn(key, 1, i + 1, 0, 0) })),
  );
}

describe('Drum Synth kernel', () => {
  it('plays a different drum on each General MIDI key', () => {
    const renders = DRUMS.map((d) => hit([d.key], 0.5)[0]);
    for (const x of renders) {
      expect(peak(x)).toBeGreaterThan(0.05);
      expect(peak(x)).toBeLessThan(1);
      for (const v of x) expect(Number.isFinite(v)).toBe(true);
    }
    // Every pair differs clearly.
    for (let a = 0; a < renders.length; a++)
      for (let b = a + 1; b < renders.length; b++) {
        let diff = 0;
        for (let i = 0; i < SR / 2; i++) diff += ((renders[a]![i] as number) - (renders[b]![i] as number)) ** 2;
        expect(Math.sqrt(diff / (SR / 2))).toBeGreaterThan(0.01);
      }
  });

  it('ignores keys without a drum and note lengths', () => {
    const [silent] = hit([60, 72]);
    expect(peak(silent)).toBe(0);
    const k = new DrumSynthKernel(testHost(SR));
    const [short] = renderInstrument(k, SR, paramBlock(drumSynthParams), [
      { frame: 0, run: () => k.noteOn(38, 1, 1, 0, 0) },
      { frame: 10, run: () => k.noteOff(1, 38, 0.5) },
    ]);
    // A 10-frame note rings exactly like a long one.
    expect(short).toEqual(hit([38])[0]);
    expect(rms(short, 2400, 4800)).toBeGreaterThan(0.001);
  });

  it('the closed hat cuts a ringing open hat (and only when "Closed cuts open" is on)', () => {
    const open = hit([46], 1, { ohatDecay: 1.5 })[0];
    const cut = hit([46, 42], 1, { ohatDecay: 1.5, chatDecay: 0.02 })[0];
    const kept = hit([46, 42], 1, { ohatDecay: 1.5, chatDecay: 0.02, hatChoke: false })[0];
    // 100 ms after the closed hat (at 0.1 s): the open hat is gone unless choking is off.
    expect(rms(cut, 0.3 * SR, 0.4 * SR)).toBeLessThan(rms(open, 0.3 * SR, 0.4 * SR) / 30);
    expect(rms(kept, 0.3 * SR, 0.4 * SR)).toBeCloseTo(rms(open, 0.3 * SR, 0.4 * SR), 3);
  });

  it('tom keys play the tom higher and lower', () => {
    const rate = (key: number) => {
      const [x] = hit([key], 0.4, { tomSweep: 0 });
      let n = 0;
      for (let i = 4800; i < 14400; i++) if ((x[i - 1] as number) < 0 && (x[i] as number) >= 0) n++;
      return n;
    };
    expect(rate(41)).toBeLessThan(rate(45));
    expect(rate(50)).toBeGreaterThan(rate(45));
  });

  it('velocity and levels scale the hit, and pan moves it', () => {
    const k = new DrumSynthKernel(testHost(SR));
    const soft = renderInstrument(k, SR / 4, paramBlock(drumSynthParams, { velocity: 1 }), [
      { frame: 0, run: () => k.noteOn(38, 0.25, 1, 0, 0) },
    ])[0];
    const loud = hit([38], 0.25, { velocity: 1 })[0];
    expect(rms(soft) / rms(loud)).toBeCloseTo(0.25, 2);
    const quiet = hit([36], 0.25, { kickLevel: -12 })[0];
    expect(rms(quiet) / rms(hit([36], 0.25)[0])).toBeCloseTo(Math.pow(10, -12 / 20), 2);
    const [l, r] = hit([39], 0.25, { clapPan: 1 });
    expect(rms(l)).toBeLessThan(1e-6);
    expect(rms(r)).toBeGreaterThan(0.01);
  });

  it('uses the param values of the block a note starts in, even for the first note', () => {
    const a = hit([36], 0.3, { kickPitch: 40 })[0];
    const b = hit([36], 0.3, { kickPitch: 90 })[0];
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs((a[i] as number) - (b[i] as number)));
    expect(diff).toBeGreaterThan(0.2);
  });

  it('a hard all-notes-off silences everything within a few milliseconds', () => {
    const k = new DrumSynthKernel(testHost(SR));
    const [x] = renderInstrument(k, SR, paramBlock(drumSynthParams, { kickDecay: 3 }), [
      { frame: 0, run: () => k.noteOn(36, 1, 1, 0, 0) },
      { frame: 4800, run: () => k.allNotesOff(true) },
    ]);
    expect(peak(x, 4800 + 300, SR)).toBe(0);
  });
});
