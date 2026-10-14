import { describe, expect, it } from 'vitest';
import type { ParamValue } from '@agstudio/sdk';
import { paramBlock, peak, renderInstrument, rms, testHost, type KernelEvent } from '@agstudio/sdk/testing';
import { demoLoop, DEMO_RATE, DEMO_SECONDS } from './demo.kernel';
import { SlicerKernel } from './kernel';
import { slicerParams } from './params';

const SR = 48000;
/** A 16th note of the demo loop (120 BPM), in frames. */
const STEP = (DEMO_RATE * 60) / 120 / 4;

function kernel(withDemo = true) {
  const k = new SlicerKernel(testHost(SR));
  if (withDemo) k.onMessage({ type: 'demo', data: demoLoop(), sampleRate: DEMO_RATE });
  return k;
}

type Values = Record<string, ParamValue>;

function play(
  k: SlicerKernel,
  notes: [frame: number, key: number, off?: number][],
  seconds = 1,
  values: Values = {},
  extra: KernelEvent[] = [],
) {
  const events: KernelEvent[] = [...extra];
  notes.forEach(([frame, key, off], i) => {
    events.push({ frame, run: () => k.noteOn(key, 1, i + 1, 0, 0) });
    if (off !== undefined) events.push({ frame: off, run: () => k.noteOff(i + 1, key, 0.5) });
  });
  return renderInstrument(
    k,
    Math.round(seconds * SR),
    paramBlock(slicerParams, { velocity: 0, level: 0, ...values }),
    events,
  );
}

/** Renders one block so the kernel computes its slices with these settings. */
function sliced(k: SlicerKernel, values: Values = {}) {
  play(k, [], 128 / SR, values);
  return Array.from({ length: k.slices }, (_, i) => k.sliceStart(i));
}

describe('Slicer kernel', () => {
  it('finds the hits of the demo loop: every slice starts just before a 16th-note step', () => {
    const starts = sliced(kernel());
    expect(starts.length).toBeGreaterThanOrEqual(12);
    expect(starts[0]).toBe(0);
    for (const s of starts) {
      const step = Math.ceil(s / STEP) * STEP;
      expect(step - s, `slice at ${s}`).toBeLessThan(256);
    }
    // More sensitivity finds more of the soft hats and ghost notes.
    expect(sliced(kernel(), { sensitivity: 1 }).length).toBeGreaterThan(sliced(kernel(), { sensitivity: 0 }).length);
  });

  it('cuts on an even grid in grid mode', () => {
    const starts = sliced(kernel(), { mode: 'grid', gridSlices: 8 });
    const length = Math.round(DEMO_SECONDS * DEMO_RATE);
    expect(starts).toEqual(Array.from({ length: 8 }, (_, i) => Math.round((i * length) / 8)));
  });

  it('plays slice n on key 60 + n, one-shot: the whole slice whatever the note length', () => {
    const k = kernel();
    const starts = sliced(k, { mode: 'grid', gridSlices: 8 });
    const slice = starts[1]! - starts[0]!; // 0.5 s
    const [x] = play(k, [[0, 61, 100]], 1, { mode: 'grid', gridSlices: 8 });
    const demo = demoLoop();
    // The second slice, sample for sample (after the 0.5 ms fade-in).
    for (let i = 100; i < 2000; i++) expect(x[i]).toBeCloseTo(demo[starts[1]! + i] as number, 5);
    expect(rms(x, slice - 4800, slice - 200)).toBeGreaterThan(0);
    expect(peak(x, slice + 10)).toBe(0);
    // Keys without a slice are silent.
    expect(
      peak(
        play(
          kernel(),
          [
            [0, 59],
            [10, 60 + 8],
          ],
          0.5,
          { mode: 'grid', gridSlices: 8 },
        )[0],
      ),
    ).toBe(0);
  });

  it('gated playback stops when the note ends (after the release)', () => {
    const values = { mode: 'grid', gridSlices: 2, playback: 'gated', release: 20 };
    const [x] = play(kernel(), [[0, 60, 4800]], 1, values);
    expect(rms(x, 0, 4800)).toBeGreaterThan(0.01);
    expect(peak(x, 4800 + 0.021 * SR)).toBe(0);
    const [y] = play(kernel(), [[0, 60, 4800]], 1, { ...values, playback: 'oneshot' });
    expect(rms(y, 9600, 24000)).toBeGreaterThan(0.01);
  });

  it('cut stops the previous slice; without it slices ring together', () => {
    const grid = { mode: 'grid', gridSlices: 4 };
    const cut = play(
      kernel(),
      [
        [0, 60],
        [4800, 62],
      ],
      1,
      grid,
    )[0];
    const alone = play(kernel(), [[4800, 62]], 1, grid)[0];
    // From 4 ms after the second note, only it is heard.
    for (let i = 4800 + 200; i < 20000; i++) expect(cut[i]).toBeCloseTo(alone[i] as number, 6);
    // Without cut, the first slice keeps sounding under the second.
    const ring = play(
      kernel(),
      [
        [0, 60],
        [4800, 62],
      ],
      1,
      { ...grid, cut: false },
    )[0];
    const first = play(kernel(), [[0, 60]], 1, grid)[0];
    for (let i = 4800 + 200; i < 20000; i++)
      expect(ring[i]).toBeCloseTo((alone[i] as number) + (first[i] as number), 6);
    expect(rms(first, 4800 + 200, 20000)).toBeGreaterThan(0.01);
  });

  it('reverse plays a slice backwards, and tune resamples it', () => {
    const k = kernel();
    const starts = sliced(k, { mode: 'grid', gridSlices: 4 });
    const end = starts[1]!;
    const [back] = play(k, [[0, 60]], 0.6, { mode: 'grid', gridSlices: 4, reverse: true, attack: 0 });
    const demo = demoLoop();
    for (let i = 200; i < 2000; i++) expect(back[i]).toBeCloseTo(demo[end - 1 - i] as number, 5);
    const [up] = play(kernel(), [[0, 60]], 1, { mode: 'grid', gridSlices: 4, tune: 12 });
    expect(peak(up, end / 2 + 10)).toBe(0);
    expect(rms(up, 0, end / 2 - 200)).toBeGreaterThan(0.01);
  });

  it('a loaded sample replaces the demo; emptying the slot brings the demo back', () => {
    const k = kernel();
    const demoSlices = sliced(k).length;
    const tone = Float32Array.from(
      { length: SR },
      (_, i) => (i < 24000 ? 0.5 : 0.9) * Math.sin(i / 10) * (i % 24000 < 12000 ? 1 : 0.02),
    );
    k.onSample('main', [tone], SR);
    const ownSlices = sliced(k);
    expect(ownSlices.length).toBeLessThan(demoSlices);
    expect(ownSlices).toContain(24000 - (24000 % 256));
    k.onSample('main', null, SR);
    expect(sliced(k).length).toBe(demoSlices);
    // No demo and no sample: nothing to play.
    expect(peak(play(kernel(false), [[0, 60]], 0.3)[0])).toBe(0);
  });
});
