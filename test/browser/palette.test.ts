/**
 * Every sound of the style palette, as the beat writer makes it (instrument, preset, settings and
 * channel level), rendered offline through the real engine: it must sound, stay finite and peak
 * sanely, and it should sit at a sensible level next to the kick.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { planBeat, writeBeat } from '@app/assistant/apply';
import { PALETTE, PITCHED_SOUNDS, type PitchedSound, type SoundChoice } from '@app/assistant/palette';
import { createServices, type Services } from '@app/services';
import type { BeatNote, BeatSpec } from '@core/beat/spec';
import { STYLES, type Style } from '@core/beat/style';
import { createEmptyProject } from '@core/model/defaults';
import type { PatternId, Project } from '@core/model/types';
import { renderOffline } from '@engine/render-offline';
import { Measurer } from '@app/analysis/measure';
import { START } from '../helpers/instruments';

const SR = 48000;

/** A phrase that shows the sound: chords for pads and keys, a riff for leads, a bass line. */
function phrase(sound: PitchedSound): BeatNote[] {
  switch (sound) {
    case '808':
      return [
        { step: 0, len: 6, key: 29, vel: 0.9 },
        { step: 8, len: 6, key: 29, vel: 0.9 },
      ];
    case 'bass':
      return [
        { step: 0, len: 3, key: 41, vel: 0.85 },
        { step: 4, len: 3, key: 41, vel: 0.85 },
        { step: 8, len: 3, key: 44, vel: 0.85 },
        { step: 12, len: 3, key: 39, vel: 0.85 },
      ];
    case 'pad':
    case 'strings':
      return [60, 63, 67].map((key) => ({ step: 0, len: 16, key, vel: 0.8 }));
    case 'keys':
      return [0, 8].flatMap((step) => [60, 63, 67, 70].map((key) => ({ step, len: 7, key, vel: 0.8 })));
    default:
      return [72, 75, 77, 79].map((key, i) => ({ step: i * 4, len: 3, key, vel: 0.8 }));
  }
}

const dbOf = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** How far under the kit's kick each sound sits on its own (see palette.ts). */
const UNDER_KICK: Record<PitchedSound, number> = {
  '808': -3,
  bass: -4,
  lead: -8,
  pluck: -9,
  keys: -10,
  pad: -10,
  bell: -10,
  strings: -11,
};

describe('style palette', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it('every sound renders, finite, with a sane peak and a level that sits next to the kick', async () => {
    const s = createServices();
    services.push(s);
    // One pattern per distinct sound (the same choice is shared by several styles).
    const seen = new Map<SoundChoice, { style: Style; sound: PitchedSound }>();
    for (const style of STYLES) for (const sound of PITCHED_SOUNDS) if (!seen.has(PALETTE[style][sound])) seen.set(PALETTE[style][sound], { style, sound });
    /** The beat writer's channel for one track, alone in a fresh project (nothing to reuse). */
    const alone = (spec: BeatSpec) => {
      const empty = produce(createEmptyProject(), (d) => {
        d.transport.bpm = 120;
      });
      const plan = planBeat(s, empty, spec);
      return { project: produce(empty, (d) => writeBeat(s, d, spec, plan)), patternId: plan.patternId };
    };
    const entries = [...seen].map(([choice, { style, sound }]) => ({
      sound,
      label: `${sound} ${choice.preset ?? choice.pluginId}${choice.params ? ` ${JSON.stringify(choice.params)}` : ''} (${style})`,
      ...alone({ title: 'x', bars: 1, style, tracks: [{ name: sound, sound, notes: phrase(sound) }] }),
    }));
    // The kick to compare with: the trap kit's, four on the floor at its channel level.
    const kick = alone({ title: 'Kick', bars: 1, style: 'trap', tracks: [{ name: 'Kick', sound: 'kick', notes: [0, 4, 8, 12].map((step) => ({ step, vel: 1 })) }] });
    const measureOne = async ({ project, patternId }: { project: Project; patternId: PatternId }) => {
      const { buffer } = await renderOffline(project, { plugins: s.plugins, view: { mode: 'pattern', patternId, loop: null }, bars: 1, sampleRate: SR, tail: 1 });
      const l = buffer.getChannelData(0).subarray(START);
      const r = buffer.getChannelData(1).subarray(START);
      const m = new Measurer(SR, true);
      m.push(l, r);
      let finite = true;
      for (let i = 0; i < l.length; i++) if (!Number.isFinite(l[i]!) || !Number.isFinite(r[i]!)) finite = false;
      return { ...m.result(), finite };
    };
    const ref = await measureOne(kick);
    const lines: string[] = [`kick (trap kit, 4 on the floor): ${ref.lufs.toFixed(1)} LUFS, peak ${ref.peakDb.toFixed(1)} dBFS`];
    const results: { label: string; sound: PitchedSound; m: Awaited<ReturnType<typeof measureOne>> }[] = [];
    for (const p of entries) {
      const m = await measureOne(p);
      results.push({ label: p.label, sound: p.sound, m });
      lines.push(`${p.label}: ${m.lufs.toFixed(1)} LUFS (${(m.lufs - ref.lufs).toFixed(1)} vs kick), peak ${m.peakDb.toFixed(1)} dBFS`);
    }
    console.log(lines.join('\n'));
    for (const { label, sound, m } of results) {
      expect(m.finite, label).toBe(true);
      expect(m.silent, label).toBe(false);
      expect(m.peakDb, label).toBeGreaterThan(-30);
      expect(m.peakDb, label).toBeLessThan(-1);
      // Where the palette puts it next to the kick (auto-level then sets the bus balance), ± 2.5 dB.
      expect(Math.abs(m.lufs - ref.lufs - UNDER_KICK[sound]), label).toBeLessThanOrEqual(2.5);
    }
    void dbOf;
  }, 120_000);
});
