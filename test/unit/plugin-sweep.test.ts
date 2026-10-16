/**
 * A sweep over every built-in worklet plugin (the kernels in test/helpers/builtin-kernels.ts):
 * presets are valid, every param at its minimum and maximum (alone, all together, and jumping
 * between the two while sound plays) gives finite, bounded audio, silent input gives silent output
 * (so the kernel can sleep), and reported tails cover what the plugin really rings for.
 */
import { describe, expect, it } from 'vitest';
import { sanitize, type ParamSpec, type ParamValue } from '@agstudio/sdk/params';
import { KERNEL_ENTRIES, type KernelEntry } from '../helpers/builtin-kernels';
import { runEntry, stats, type Segment } from '../helpers/kernel-run';

/** A full-scale-ish input through +24 dB of makeup, or sixteen pads at once, stays far below this. */
const BOUND = 64;
const SECONDS = 0.15;

function extremes(spec: ParamSpec): [ParamValue, ParamValue] {
  if (spec.type === 'float' || spec.type === 'int') return [spec.min, spec.max];
  if (spec.type === 'bool') return [false, true];
  return [spec.options[0] as string, spec.options[spec.options.length - 1] as string];
}

function bounds(entry: KernelEntry) {
  const min: Record<string, ParamValue> = {};
  const max: Record<string, ParamValue> = {};
  for (const [key, spec] of Object.entries(entry.params)) [min[key], max[key]] = extremes(spec) as [ParamValue, ParamValue];
  return { min, max };
}

/** Plugins that make sound by themselves while their input is silent (hiss), so they never sleep. */
const GENERATORS = new Set(['agstudio.lofi', 'agstudio.vocoder']);
/** Reverb tails are reported by the plugin instance (they follow Decay), not by its definition. */
const OWN_TAIL = new Set(['agstudio.reverb']);

describe.each(KERNEL_ENTRIES.map((e) => [e.id, e] as const))('%s', (_id, entry) => {
  it('has presets that set only existing params, to values in range', () => {
    expect(entry.presets.length).toBeGreaterThan(0);
    for (const preset of entry.presets)
      for (const [key, value] of Object.entries(preset.params)) {
        const spec = entry.params[key];
        expect(spec, `${preset.name}: unknown param ${key}`).toBeDefined();
        expect(sanitize(spec as ParamSpec, value), `${preset.name}: ${key}=${String(value)}`).toBe(value);
      }
  });

  it('stays finite and bounded with every param at its minimum and maximum', { timeout: 60_000 }, () => {
    const { min, max } = bounds(entry);
    const check = (timeline: Segment[], label: string, releaseAt?: number) => {
      const s = stats(runEntry(entry, timeline, { releaseAt }));
      expect(s.bad, `${label}: NaN/Infinity`).toBe(0);
      expect(s.peak, `${label}: peak`).toBeLessThan(BOUND);
    };
    check([{ seconds: SECONDS * 2, values: min }], 'all at minimum');
    check([{ seconds: SECONDS * 2, values: max }], 'all at maximum');
    // Jumping between the extremes while sound plays (filters, delay lines and envelopes must recover).
    check(
      [
        { seconds: 0.2, values: min },
        { seconds: 0.2, values: max },
        { seconds: 0.2, values: min },
      ],
      'min, max, min',
      0.4,
    );
    for (const [key, spec] of Object.entries(entry.params)) {
      const [lo, hi] = extremes(spec);
      check([{ seconds: SECONDS, values: { [key]: lo } }], `${key} = ${String(lo)}`);
      check([{ seconds: SECONDS, values: { [key]: hi } }], `${key} = ${String(hi)}`);
    }
  });

  if (entry.kind === 'effect') {
    it.skipIf(GENERATORS.has(entry.id))('goes silent after its input does, so it can sleep', { timeout: 60_000 }, () => {
      // Half a second of music, then silence: by 10 s even the longest default tail is below -120 dB.
      const r = runEntry(entry, [{ seconds: 11, values: {} }], { input: (t) => (t < 0.5 ? 1 : 0) });
      expect(stats(r, 0, 0.5).peak).toBeGreaterThan(0);
      expect(stats(r, 10, 11).peak).toBeLessThan(1e-6);
    });

    it.skipIf(OWN_TAIL.has(entry.id) || GENERATORS.has(entry.id) || entry.id === 'agstudio.stutter')(
      'reports a tail that covers its own, in every preset',
      { timeout: 60_000 },
      () => {
        const reported = typeof entry.def.tailTime === 'number' ? entry.def.tailTime : 0;
        for (const preset of [{ name: 'default', params: {} }, ...entry.presets]) {
          const r = runEntry(entry, [{ seconds: 2, values: preset.params }], { input: (t) => (t < 0.5 ? 1 : 0) });
          // Below -60 dB (0.001) once the reported tail (plus 0.1 s of slack for filter ring) is over.
          const after = stats(r, 0.5 + reported + 0.1);
          expect(after.peak, `${preset.name}: still ringing at ${reported + 0.1} s`).toBeLessThan(1e-3);
        }
      },
    );
  } else {
    it('goes silent after its notes are released and the reported tail is over', { timeout: 120_000 }, () => {
      const tail = typeof entry.def.tailTime === 'function' ? 4 : (entry.def.tailTime ?? 1);
      const releaseAt = 0.3;
      for (const preset of [{ name: 'default', params: {} }, ...entry.presets]) {
        const r = runEntry(entry, [{ seconds: releaseAt + tail + 0.2, values: preset.params }], { releaseAt });
        expect(stats(r, 0, releaseAt).peak, `${preset.name}: makes sound`).toBeGreaterThan(0.001);
        expect(stats(r, releaseAt + tail).peak, `${preset.name}: rings past ${tail} s`).toBeLessThan(1e-3);
      }
    });
  }
});
