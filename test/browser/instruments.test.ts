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
import drumPads from '../../src/plugins/builtin/drum-pads';
import fm from '../../src/plugins/builtin/fm';

/** The master limiter's ceiling is −0.3 dBFS (0.966): staying below 0.95 means it never had to act. */
const BELOW_LIMITER = 0.95;

/** How each instrument is played in the shared checks. */
interface Case {
  def: PluginDef;
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
  {
    def: drumPads as PluginDef,
    // Every pad once, an eighth note apart (two bars).
    notes: Array.from({ length: 16 }, (_, i) => ({ at: i * 0.5, len: 0.25, key: 36 + i })),
    opts: { bars: 2, tail: 3 },
    silentAfter: 6.5,
  },
  {
    def: fm as PluginDef,
    // A chord, then a little melody.
    notes: [
      { at: 0, len: 1, key: 60 },
      { at: 0, len: 1, key: 64 },
      { at: 0, len: 1, key: 67 },
      { at: 1.5, len: 0.5, key: 72 },
      { at: 2, len: 0.5, key: 69 },
      { at: 2.5, len: 1, key: 65, velocity: 0.6 },
    ],
    opts: { tail: 2 },
    silentAfter: 3,
  },
];

describe('M13 instruments', () => {
  for (const c of cases) {
    describe(c.def.name, () => {
      it('makes sound, stops after release, and stays finite, below the limiter and without DC', async () => {
        const buffer = await renderNotes(c.def, c.notes, c.opts);
        const all = analyze(buffer);
        expect(all.finite).toBe(true);
        expect(all.peak).toBeGreaterThan(0.05);
        expect(all.peak).toBeLessThan(BELOW_LIMITER);
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
          expect(analyze(renders[a]!).peak, presets[a]!.name).toBeLessThan(BELOW_LIMITER);
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

  describe('Drum Pads samples', () => {
    it('a sample in a pad slot replaces its built-in sound', async () => {
      const notes = [{ at: 0, len: 0.25, key: 36 }];
      const builtin = await renderNotes(drumPads as PluginDef, notes);
      const sampled = await renderNotes(drumPads as PluginDef, notes, { samples: { pad1: 'kit/clap' } });
      expect(analyze(sampled).peak).toBeGreaterThan(0.05);
      expect(fingerprintDistance(builtin, sampled)).toBeGreaterThan(3);
      // The same kit sound on two pads plays the same.
      const other = await renderNotes(drumPads as PluginDef, [{ at: 0, len: 0.25, key: 37 }], {
        samples: { pad2: 'kit/clap' },
      });
      expect(maxDiff(sampled, other)).toBeLessThan(1e-6);
    });
  });
});
