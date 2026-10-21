/**
 * The factory racks on real audio (offline renders in headless Chrome): each one sounds (finite, not louder than the
 * master's limiter allows, within a few dB of the sound that went in), its macros change the sound at both ends, and a render
 * is the same every time.
 */
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { setChannelProp, setPluginParam } from '@core/ops/channels';
import type { InsertId, Project, SlotId } from '@core/model/types';
import { buildFactoryRack } from '@app/racks/build';
import { FACTORY_RACKS } from '@app/racks/factory';
import { createTestServices } from '@app/testing';
import { maxDiff, resolver, rms } from '../helpers/fixtures';
import { channelsProject, renderDocs } from '../helpers/routing';
import { noise } from '../helpers/tone';

const services = createTestServices();
const plugins = resolver(noise);
const database = (project: Project, recipe: (typeof FACTORY_RACKS)[number], insert: InsertId) => {
  const built = buildFactoryRack(services, recipe);
  if ('error' in built) throw new Error(built.error);
  return { project: produce(project, (d) => void d.mixer.inserts[insert]!.fx.push(built.slot as never)), slot: built.slot };
};

/** Two different noises, one hard left and one hard right: a stereo sound with sides to widen. */
function noiseSong() {
  const made = channelsProject([
    { def: noise, notes: [[0, 3840, 60]], insert: 1, volume: 0.5 },
    { def: noise, notes: [[0, 3840, 60]], insert: 1, volume: 0.5 },
  ]);
  const project = produce(made.project, (d) => {
    setChannelProp(d, made.channels[0]!, 'pan', -1);
    setChannelProp(d, made.channels[1]!, 'pan', 1);
  });
  return { ...made, project };
}
const db = (ratio: number) => 20 * Math.log10(ratio);

describe('factory racks', () => {
  for (const recipe of FACTORY_RACKS) {
    describe(recipe.name, () => {
      it('sounds, near the level that went in, and renders the same every time', async () => {
        const { project, patternId, ins } = noiseSong();
        const dry = await renderDocs([project], patternId, plugins, { bars: 2 });
        const { project: racked } = database(project, recipe, ins[1]!);
        const out = await renderDocs([racked], patternId, plugins, { bars: 2 });
        const gain = db(rms(out) / rms(dry));
        expect(Number.isFinite(gain), 'finite').toBe(true);
        expect(gain, `${recipe.name}: ${gain.toFixed(1)} dB against the dry sound`).toBeGreaterThan(-9);
        expect(gain, `${recipe.name}: ${gain.toFixed(1)} dB against the dry sound`).toBeLessThan(9);
        const again = await renderDocs([racked], patternId, plugins, { bars: 2 });
        expect(maxDiff(out, again)).toBe(0);
      });

      it('has macros that change the sound from one end of the knob to the other', async () => {
        const { project, patternId, ins } = noiseSong();
        const { project: racked, slot } = database(project, recipe, ins[1]!);
        const mapped = slot.rack.macros.flatMap((macro, index) => (macro.mappings.length > 0 ? [index] : []));
        for (const index of mapped) {
          const at = (value: number) =>
            renderDocs(
              [produce(racked, (d) => void setPluginParam(d, { kind: 'fx', insertId: ins[1]!, slotId: slot.id as SlotId }, `macro${index + 1}`, value))],
              patternId,
              plugins,
              { bars: 1 },
            );
          const low = await at(0);
          const high = await at(1);
          expect(maxDiff(low, high), `${recipe.name}: macro ${index + 1} “${slot.rack.macros[index]!.name}” does nothing`).toBeGreaterThan(1e-4);
          expect(Number.isFinite(rms(low)) && Number.isFinite(rms(high))).toBe(true);
        }
      });
    });
  }
});
