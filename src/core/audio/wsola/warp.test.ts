import { describe, expect, it } from 'vitest';
import { autocorrelationPitch, clickTrain, harmonicTone, onsetFrames } from '../../../../test/helpers/audio';
import { WarpTimeMap, warpChannels } from './warp';

const SR = 48000;
const OPTIONS = { sampleRate: SR, frameMs: 30, toleranceMs: 8, transients: false };

/** A map that moves the sound later by `delay` frames from `at` on (before it, no change), over `ramp` frames. */
function delayMap(length: number, delay: number, at: number, ramp: number): WarpTimeMap {
  return new WarpTimeMap(Float64Array.from([0, at, at + ramp, length]), Float64Array.from([0, at, at + ramp - delay, length - delay]));
}

describe('warpChannels', () => {
  it('returns the input when the map is the identity', () => {
    const x = harmonicTone(220, 1, SR);
    const map = new WarpTimeMap(Float64Array.from([0, x.length]), Float64Array.from([0, x.length]));
    const [y] = warpChannels([x], x.length, map, OPTIONS);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs((y as Float32Array)[i]! - x[i]!));
    expect(worst).toBeLessThan(1e-4);
  });

  it('moves a click along a map that changes speed, and keeps the pitch of a tone', () => {
    const clicks = clickTrain(0.5, 2, SR, 0.1);
    // From 1.1 s on the output plays the input 100 ms ahead; between 0.9 s and 1.1 s the input runs 1.5× as fast to get
    // there, so the click at 1.1 s in the input (the clicks are at 0.1, 0.6, 1.1 and 1.6 s) comes out at 0.9 + (1.1 − 0.9) / 1.5 s.
    const delay = Math.round(0.1 * SR);
    const at = SR * 0.9;
    const map = new WarpTimeMap(Float64Array.from([0, at, at + 0.2 * SR, clicks.length]), Float64Array.from([0, at, at + 0.2 * SR + delay, clicks.length]));
    const [moved] = warpChannels([clicks], clicks.length, map, OPTIONS);
    const before = onsetFrames(clicks, SR, 0.2, 0.08);
    const after = onsetFrames(moved as Float32Array, SR, 0.2, 0.08);
    expect(after.length).toBeGreaterThanOrEqual(3);
    // The clicks before the move stay; the one at 1.1 s comes where the map says (within the search tolerance).
    expect(Math.abs(after[0]! - before[0]!) / SR).toBeLessThan(0.02);
    const wanted = 0.9 + 0.2 / 1.5;
    const nearOne = after.find((f) => Math.abs(f / SR - wanted) < 0.03);
    expect(nearOne).toBeDefined();

    const tone = harmonicTone(220, 2, SR);
    const [warped] = warpChannels([tone], tone.length, delayMap(tone.length, Math.round(0.05 * SR), SR * 0.5, SR * 0.5), OPTIONS);
    const hz = autocorrelationPitch(warped as Float32Array, SR, SR * 1.2, SR * 1.5);
    expect(Math.abs(hz / 220 - 1)).toBeLessThan(0.005);
  });

  it('plays a kept span exactly as the input continues', () => {
    const x = harmonicTone(180, 1, SR);
    const delay = Math.round(0.03 * SR);
    const map = new WarpTimeMap(
      Float64Array.from([0, x.length]),
      Float64Array.from([delay, x.length + delay]),
      [{ from: SR * 0.3, to: SR * 0.6 }],
    );
    const [y] = warpChannels([x], x.length, map, OPTIONS);
    // Inside the kept span the output is the input from `delay` frames later, to within a few frames of search at the entry.
    const lag = (() => {
      let best = 0;
      let bestError = Infinity;
      for (let d = delay - 120; d <= delay + 120; d++) {
        let error = 0;
        for (let i = SR * 0.4; i < SR * 0.5; i++) error += ((y as Float32Array)[i]! - x[i + d]!) ** 2;
        if (error < bestError) {
          bestError = error;
          best = d;
        }
      }
      return best;
    })();
    expect(Math.abs(lag - delay)).toBeLessThan(0.003 * SR);
  });

  it('is deterministic and the same length as asked', () => {
    const x = harmonicTone(260, 0.8, SR);
    const map = delayMap(x.length, 400, 4000, 8000);
    const a = warpChannels([x], x.length, map, OPTIONS);
    const b = warpChannels([x], x.length, delayMap(x.length, 400, 4000, 8000), OPTIONS);
    expect(a[0]!.length).toBe(x.length);
    expect(Buffer.from(a[0]!.buffer).equals(Buffer.from(b[0]!.buffer))).toBe(true);
  });

  it('rejects a map with too few anchors', () => {
    expect(() => new WarpTimeMap(Float64Array.from([0]), Float64Array.from([0]))).toThrow(RangeError);
  });
});
