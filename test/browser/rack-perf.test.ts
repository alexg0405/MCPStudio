/**
 * What a rack costs on top of the effects in it: the same four effects on an insert, in a one-branch rack, in four parallel
 * branches and in four bands, each rendered offline with the wall clock around the render only (best of a few attempts).
 */
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { makePluginInstance } from '@core/model/defaults';
import type { InsertId, PatternId, Project, RackSplit } from '@core/model/types';
import { addFxSlot } from '@core/ops/mixer';
import { addRackFx, addRackSlot } from '@core/ops/racks';
import { Engine } from '@engine/engine';
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import chorus from '../../src/plugins/builtin/chorus';
import compressor from '../../src/plugins/builtin/compressor';
import eqPro from '../../src/plugins/builtin/eq-pro';
import saturator from '../../src/plugins/builtin/saturator';
import { resolver } from '../helpers/fixtures';
import { perfLimit, settle } from '../helpers/perf';
import { channelsProject, SR } from '../helpers/routing';
import { noise } from '../helpers/tone';

const effects = [eqPro, compressor, saturator, chorus] as PluginDef[];
const plugins = resolver(noise);
const instance = (def: PluginDef) => makePluginInstance(def.id, def.version, defaultValues(def.params));
const BARS = 4;

/** Noise into insert 1, with the four effects set up by `build`. */
function song(build: (d: Parameters<typeof addFxSlot>[0], insertId: InsertId) => void): { project: Project; patternId: PatternId } {
  const { project, patternId, ins } = channelsProject([{ def: noise, notes: [[0, 3840, 60]], insert: 1 }]);
  return { project: produce(project, (d) => build(d, ins[1] as InsertId)), patternId };
}

const onInsert = () => song((d, insert) => effects.forEach((def) => addFxSlot(d, insert, instance(def))));

/** The four effects in a rack: all in one branch, or one to a branch. */
function inRack(split: RackSplit, oneBranchEach: boolean) {
  return song((d, insert) => {
    const rackId = addRackSlot(d, insert, { split, branches: oneBranchEach ? 4 : 1 })!;
    const branches = d.mixer.inserts[insert]!.fx[0]!.rack!.branches.map((branch) => branch.id);
    effects.forEach((def, i) => addRackFx(d, insert, rackId, branches[oneBranchEach ? i : 0]!, instance(def)));
  });
}

/** Milliseconds it takes to render, with the engine built and everything loaded beforehand. */
async function renderMs({ project, patternId }: { project: Project; patternId: PatternId }): Promise<number> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(SR * (2 * BARS + 1)), sampleRate: SR });
  const engine = new Engine(ctx, { plugins }, true);
  engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
  engine.setTransportView({ mode: 'pattern', patternId, loop: null });
  await engine.ready();
  const preRoll = 2048 / SR;
  engine.startOffline(0, preRoll);
  engine.pumpOffline(preRoll + engine.barSeconds() * BARS - 1e-6);
  await engine.syncWorklets();
  const started = performance.now();
  await ctx.startRendering();
  const elapsed = performance.now() - started;
  await engine.dispose();
  return elapsed;
}

const best = (song: ReturnType<typeof onInsert>) => settle(() => renderMs(song), () => false, { attempts: 4 });

describe('what a rack costs', { tags: ['perf'] }, () => {
  it('a one-branch rack costs next to nothing more than the same effects on the insert', async () => {
    const chain = await best(onInsert());
    const rack = await best(inRack('parallel', false));
    expect(rack / chain, `chain ${chain.toFixed(0)} ms, rack ${rack.toFixed(0)} ms`).toBeLessThan(perfLimit(1.15, 2));
  });

  it('four parallel branches and four bands cost little more than the effects themselves', async () => {
    const chain = await best(onInsert());
    const parallel = await best(inRack('parallel', true));
    const bands = await best(inRack('bands', true));
    expect(parallel / chain, `chain ${chain.toFixed(0)} ms, parallel ${parallel.toFixed(0)} ms`).toBeLessThan(perfLimit(1.3, 2.5));
    expect(bands / chain, `chain ${chain.toFixed(0)} ms, bands ${bands.toFixed(0)} ms`).toBeLessThan(perfLimit(1.6, 3));
  });
});
