import { describe, expect, it } from 'vitest';
import type { ParamValue, PluginDef } from '@agstudio/sdk';
import { maxDiff } from '../helpers/fixtures';
import {
  analyze,
  fingerprintDistance,
  renderNotes,
  rmsAt,
  START,
  type InstrumentRender,
  type TestNote,
} from '../helpers/instruments';
import drumSynth from '../../src/plugins/builtin/drum-synth';

/** How each instrument is played in the shared checks. */
interface Case {
  def: PluginDef;
  /** A short phrase (within the first bar at 120 BPM). */
  notes: TestNote[];
  opts?: InstrumentRender;
  /** Seconds after the music starts by which everything has died away. */
  silentAfter: number;
}

const cases: Case[] = [
  {
    def: drumSynth as PluginDef,
    notes: [36, 38, 42, 46, 39, 45, 37].map((key, i) => ({ at: i * 0.25, len: 0.25, key })),
    opts: { tail: 2.5 },
    silentAfter: 3.5,
  },
];

describe('M13 instruments', () => {
  for (const c of cases) {
    describe(c.def.name, () => {
      it('makes sound, stops after release, and stays finite, below clipping and without DC', async () => {
        const buffer = await renderNotes(c.def, c.notes, c.opts);
        const all = analyze(buffer);
        expect(all.finite).toBe(true);
        expect(all.peak).toBeGreaterThan(0.05);
        expect(all.peak).toBeLessThan(0.97);
        // Nothing before the first note.
        expect(analyze(buffer, 0, START - 1).peak).toBe(0);
        expect(rmsAt(buffer, 0, 0.5)).toBeGreaterThan(0.01);
        // Silent at the end.
        const end = Math.round(START + c.silentAfter * buffer.sampleRate);
        expect(end).toBeLessThan(buffer.length);
        expect(analyze(buffer, end, buffer.length).peak).toBeLessThan(1e-4);
        // No DC: the mean is tiny compared with the level.
        for (const dc of all.dc) expect(Math.abs(dc)).toBeLessThan(Math.max(2e-4, 0.03 * all.rms));
      });

      it('renders the same audio every time', async () => {
        const a = await renderNotes(c.def, c.notes, c.opts);
        const b = await renderNotes(c.def, c.notes, { ...c.opts, chunk: 128 * 37 });
        expect(maxDiff(a, b)).toBe(0);
      });

      it('has presets that sound clearly different from each other', async () => {
        const presets = c.def.presets ?? [];
        expect(presets.length).toBeGreaterThanOrEqual(4);
        const renders = await Promise.all(
          presets.map((p) =>
            renderNotes(c.def, c.notes, {
              ...c.opts,
              params: { ...c.opts?.params, ...(p.params as Record<string, ParamValue> | undefined) },
            }),
          ),
        );
        for (let a = 0; a < renders.length; a++) {
          expect(analyze(renders[a]!).peak, presets[a]!.name).toBeLessThan(0.97);
          expect(analyze(renders[a]!).peak, presets[a]!.name).toBeGreaterThan(0.02);
          for (let b = a + 1; b < renders.length; b++)
            expect(
              fingerprintDistance(renders[a]!, renders[b]!),
              `${presets[a]!.name} vs ${presets[b]!.name}`,
            ).toBeGreaterThan(1.5);
        }
      });
    });
  }
});
