import { describe, expect, it } from 'vitest';
import type { ParamValue } from '@agstudio/sdk';
import { paramBlock, peak, renderInstrument, rms, testHost, type KernelEvent } from '@agstudio/sdk/worklet/testing';
import { DrumPadsKernel } from './kernel';
import { drumPadsParams, PADS, SOUND_IDS } from './params';
import { builtinSound } from './sounds.kernel';

const SR = 48000;

function kernel(withSounds = true) {
  const k = new DrumPadsKernel(testHost(SR));
  if (withSounds) k.onMessage({ type: 'sounds', sampleRate: SR, sounds: SOUND_IDS.map((id) => builtinSound(id, SR)) });
  return k;
}

/** Hits `[frame, key, velocity?]` on a kernel; returns the left and right channels. */
function play(
  k: DrumPadsKernel,
  hits: [number, number, number?][],
  seconds = 1,
  values: Record<string, ParamValue> = {},
  extra: KernelEvent[] = [],
) {
  return renderInstrument(k, Math.round(seconds * SR), paramBlock(drumPadsParams, values), [
    ...hits.map(([frame, key, vel], i) => ({ frame, run: () => k.noteOn(key, vel ?? 1, i + 1, 0, 0) })),
    ...extra,
  ]);
}

/** A test sample: a 1 s ramp from 0 to 1 (so speed and direction are easy to read). */
const ramp = Float32Array.from({ length: SR }, (_, i) => i / SR);

describe('Drum Pads kernel', () => {
  it('plays the built-in kit on keys 36–51 and nothing elsewhere', () => {
    for (let pad = 0; pad < PADS; pad++) {
      const [l] = play(kernel(), [[0, 36 + pad]], 0.3);
      expect(peak(l), `pad ${pad + 1}`).toBeGreaterThan(0.05);
      expect(peak(l)).toBeLessThan(1.5);
    }
    expect(
      peak(
        play(kernel(), [
          [0, 35],
          [100, 52],
          [200, 60],
        ])[0],
      ),
    ).toBe(0);
    // Nothing until the main thread has sent the built-in sounds.
    expect(peak(play(kernel(false), [[0, 36]])[0])).toBe(0);
  });

  it('choke groups cut each other: a closed hat stops the open hat within 4 ms', () => {
    const open = play(kernel(), [[0, 46]], 1)[0];
    const cut = play(
      kernel(),
      [
        [0, 46],
        [9600, 42],
      ],
      1,
    )[0];
    expect(rms(open, 9600, 14400)).toBeGreaterThan(0.001);
    // From 4 ms after the closed hat on, only the closed hat remains (it is short: 50 ms).
    expect(rms(cut, 9600 + 4800, 24000)).toBeLessThan(1e-4);
    // Different groups (or none) leave each other alone.
    const apart = play(
      kernel(),
      [
        [0, 46],
        [9600, 42],
      ],
      1,
      { pad7Choke: 2 },
    )[0];
    expect(rms(apart, 9600 + 4800, 24000)).toBeCloseTo(rms(open, 9600 + 4800, 24000), 6);
    const none = play(
      kernel(),
      [
        [0, 46],
        [9600, 42],
      ],
      1,
      { pad7Choke: 0, pad11Choke: 0 },
    )[0];
    expect(rms(none, 9600 + 4800, 24000)).toBeCloseTo(rms(open, 9600 + 4800, 24000), 6);
  });

  it('a pad in a choke group cuts its own earlier hit, a pad without one lets hits overlap', () => {
    const once = play(kernel(), [[0, 46]], 1)[0];
    const twice = play(
      kernel(),
      [
        [0, 46],
        [4800, 46],
      ],
      1,
    )[0];
    // The second hit replaced the first: from 4 ms after it, it matches one hit shifted by 4800.
    let diff = 0;
    for (let i = 4800 + 400; i < SR; i++)
      diff = Math.max(diff, Math.abs((twice[i] as number) - (once[i - 4800] as number)));
    expect(diff).toBeLessThan(1e-6);
    const crash = play(
      kernel(),
      [
        [0, 49],
        [4800, 49],
      ],
      1,
    )[0];
    const single = play(kernel(), [[0, 49]], 1)[0];
    expect(rms(crash, 9600, 20000)).toBeGreaterThan(rms(single, 9600, 20000) * 1.2);
  });

  it('a loaded sample replaces the built-in sound until the slot is emptied', () => {
    const k = kernel();
    k.onSample('pad1', [ramp], SR);
    const [l] = play(k, [[0, 36]], 0.5, { pad1Level: 0, velocity: 0, level: 0 });
    for (let i = 0; i < 1000; i++) expect(l[i]).toBeCloseTo(i / SR, 6);
    k.onSample('pad1', null, SR);
    // (The ramp's hit is still sounding: stop it so only the next hit is heard.)
    k.reset();
    const [kick] = play(k, [[0, 36]], 0.5);
    expect(kick).toEqual(play(kernel(), [[0, 36]], 0.5)[0]);
  });

  it('tune resamples, reverse plays backwards, decay fades, and samples at other rates keep their pitch', () => {
    const k = kernel();
    k.onSample('pad2', [ramp], SR);
    const up = play(k, [[0, 37]], 1, { pad2Tune: 12, velocity: 0, level: 0 })[0];
    expect(up[1000]).toBeCloseTo(2000 / SR, 5);
    expect(up[SR / 2 + 10]).toBe(0);
    const back = play(k, [[0, 37]], 1, { pad2Reverse: true, velocity: 0, level: 0 })[0];
    expect(back[0]).toBeCloseTo(1 - 1 / SR, 5);
    expect(back[24000]).toBeCloseTo(0.5, 3);
    const faded = play(k, [[0, 37]], 1, { pad2Decay: 0.1, velocity: 0, level: 0 })[0];
    // 60 dB down after the decay time (the ramp is at 0.1 there).
    expect(Math.abs(faded[4800] as number)).toBeLessThan(0.1 * 0.0011);
    const k2 = kernel();
    k2.onSample('pad2', [Float32Array.from({ length: 24000 }, (_, i) => i / 24000)], 24000);
    const half = play(k2, [[0, 37]], 1, { velocity: 0, level: 0 })[0];
    expect(half[24000]).toBeCloseTo(0.5, 3);
  });

  it('level, pan and velocity scale and place the hit', () => {
    const base = play(kernel(), [[0, 38]], 0.3)[0];
    const quiet = play(kernel(), [[0, 38]], 0.3, { pad3Level: -12 })[0];
    expect(rms(quiet) / rms(base)).toBeCloseTo(Math.pow(10, -12 / 20), 3);
    const [l, r] = play(kernel(), [[0, 38]], 0.3, { pad3Pan: -1 });
    expect(rms(r)).toBe(0);
    expect(rms(l)).toBeCloseTo(rms(base), 6);
    const soft = play(kernel(), [[0, 38, 0.5]], 0.3, { velocity: 1 })[0];
    const hard = play(kernel(), [[0, 38, 1]], 0.3, { velocity: 1 })[0];
    expect(rms(soft) / rms(hard)).toBeCloseTo(0.5, 3);
  });

  it('a hard all-notes-off silences everything within a few milliseconds', () => {
    const k = kernel();
    const [l] = play(k, [[0, 49]], 1, {}, [{ frame: 4800, run: () => k.allNotesOff(true) }]);
    expect(peak(l, 4800 + 200, SR)).toBe(0);
  });
});
