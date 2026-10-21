/**
 * Effect racks in the engine (offline renders in headless Chrome): parallel branches line up in time, the bands add up flat,
 * mid/side and left/right come back as they went in, macros move what they are mapped to (by hand and by automation),
 * the delay compensation counts the rack, and a render is the same every time.
 */
import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { makePluginInstance } from '@core/model/defaults';
import type { BranchId, InsertId, Project, RackSplit, SlotId } from '@core/model/types';
import { setChannelProp, setPluginParam } from '@core/ops/channels';
import { setFxSlotEnabled } from '@core/ops/mixer';
import { addBranch, addRackFx, addRackSlot, setBranch, setMacroMapping, setRackSplit } from '@core/ops/racks';
import { renderOffline } from '@engine/render-offline';
import type { Engine } from '@engine/engine';
import { defaultValues, defineEffect, Fft, p, type PluginDef } from '@agstudio/sdk';
import { automate, pt, rmsEnvelope } from '../helpers/automation';
import { maxDiff, resolver, rms, withInsert } from '../helpers/fixtures';
import { heldNote, tone } from '../helpers/tone';
import {
  argmax,
  channelsProject,
  impulse,
  latentEffect,
  renderDocs,
  rmsRange,
  sine,
  SR,
} from '../helpers/routing';

/** A graph effect with a gain knob (an AudioParam, so a macro can sweep it smoothly). */
const gainFx = defineEffect({
  id: 'test.gain',
  name: 'Gain',
  version: 1,
  params: { gain: p.float(0, 2, 1) },
  create({ audioContext: ac, params }) {
    const node = new GainNode(ac, { gain: params.gain.value });
    params.gain.bind(node.gain);
    return { input: node, output: node, dispose: () => node.disconnect() };
  },
}) as PluginDef;

const latent375 = latentEffect(375);
const latent160 = latentEffect(160);
const plugins = resolver(impulse, sine, latent375, latent160, gainFx);
const BAR = 3840;

const instance = (def: PluginDef, params: Record<string, number> = {}) =>
  makePluginInstance(def.id, def.version, { ...defaultValues(def.params), ...params });

interface RackSetup {
  rackId: SlotId;
  branches: BranchId[];
}

/** The project with a rack on insert `insertId`: `build` fills it in. */
function withRack(
  project: Project,
  insertId: InsertId,
  options: { split?: RackSplit; branches?: number },
  build: (d: Parameters<typeof addRackSlot>[0], rack: RackSetup) => void = () => {},
): Project {
  return produce(project, (d) => {
    const rackId = addRackSlot(d, insertId, { split: options.split ?? 'parallel', branches: options.branches ?? 0 })!;
    const branches = d.mixer.inserts[insertId]!.fx[0]!.rack!.branches.map((branch) => branch.id);
    build(d, { rackId, branches });
  });
}

/** The mixer's latency in whole frames. */
const latencyFrames = (engine: Engine): number => Math.round(engine.graphLatency() * SR);

/** The spectrum of 65536 samples of channel 0 from `start`. */
function spectrumOf(buffer: AudioBuffer, start: number): { re: Float64Array; im: Float64Array } {
  const size = 65536;
  const data = buffer.getChannelData(0);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) re[i] = data[start + i] as number;
  new Fft(size).forward(re, im);
  return { re, im };
}

/** How much louder `out` is than `dry` at each frequency of the range, in dB: its lowest and highest. */
function responseDb(out: AudioBuffer, dry: AudioBuffer, from: number, to: number): { min: number; max: number; at(hz: number): number } {
  // Both from just before the impulse went in (a band's own peak comes later than the impulse: the front must not be cut).
  const start = Math.max(0, argmax(dry) - 16);
  const a = spectrumOf(out, start);
  const b = spectrumOf(dry, start);
  const size = a.re.length;
  const db = (bin: number) => 20 * Math.log10(Math.hypot(a.re[bin] as number, a.im[bin] as number) / Math.hypot(b.re[bin] as number, b.im[bin] as number));
  let min = Infinity;
  let max = -Infinity;
  for (let bin = Math.ceil((from * size) / SR); bin <= Math.floor((to * size) / SR); bin++) {
    min = Math.min(min, db(bin));
    max = Math.max(max, db(bin));
  }
  return { min, max, at: (hz) => db(Math.round((hz * size) / SR)) };
}


/** One impulse on insert 1, quiet enough that three of them added up stay under the master's limiter. */
const impulseProject = () => channelsProject([{ def: impulse, notes: [[0, 240, 60]], insert: 1, volume: 0.3 }]);
const sineProject = () => channelsProject([{ def: sine, notes: [[0, BAR, 69]], insert: 1 }]);

describe('parallel branches', () => {
  it('line up in time: an impulse through branches of different latency adds up at one place', async () => {
    const { project, patternId, ins } = impulseProject();
    const dry = await renderDocs([project], patternId, plugins);
    const at = argmax(dry);
    const unit = dry.getChannelData(0)[at] as number;
    const doc = withRack(project, ins[1]!, { branches: 3 }, (d, { rackId, branches }) => {
      addRackFx(d, ins[1]!, rackId, branches[0]!, instance(latent375));
      addRackFx(d, ins[1]!, rackId, branches[1]!, instance(latent160));
      // The third branch has no effects: it is the dry sound, and has to wait for the slowest.
    });
    let latency = -1;
    const out = await renderDocs([doc], patternId, plugins, { inspect: (engine) => (latency = latencyFrames(engine)) });
    expect(latency).toBe(375);
    const data = out.getChannelData(0);
    expect(argmax(out)).toBe(at + 375);
    expect(data[at + 375]).toBeCloseTo(3 * unit, 6);
    let elsewhere = 0;
    for (let i = 0; i < data.length; i++) if (i !== at + 375) elsewhere = Math.max(elsewhere, Math.abs(data[i] as number));
    expect(elsewhere).toBeLessThan(1e-6);
  });

  it('count the effects of a branch one after the other, and the rack the slowest branch', async () => {
    const { project, patternId, ins } = impulseProject();
    const doc = withRack(project, ins[1]!, { branches: 2 }, (d, { rackId, branches }) => {
      addRackFx(d, ins[1]!, rackId, branches[0]!, instance(latent375));
      addRackFx(d, ins[1]!, rackId, branches[0]!, instance(latent160));
      addRackFx(d, ins[1]!, rackId, branches[1]!, instance(latent375));
    });
    let latency = -1;
    await renderDocs([doc], patternId, plugins, { inspect: (engine) => (latency = latencyFrames(engine)) });
    expect(latency).toBe(535);
  });

  it('follow what is on: bypassing the slow effect makes the rack quicker, and the rest still lines up', async () => {
    const { project, patternId, ins } = impulseProject();
    const dry = await renderDocs([project], patternId, plugins);
    let slow!: SlotId;
    const doc = withRack(project, ins[1]!, { branches: 2 }, (d, { rackId, branches }) => {
      slow = addRackFx(d, ins[1]!, rackId, branches[0]!, instance(latent375))!;
      addRackFx(d, ins[1]!, rackId, branches[1]!, instance(latent160));
    });
    const bypassed = produce(doc, (d) => void setFxSlotEnabled(d, ins[1]!, slow, false));
    let latency = -1;
    const out = await renderDocs([doc, bypassed], patternId, plugins, { inspect: (engine) => (latency = latencyFrames(engine)) });
    expect(latency).toBe(160);
    expect(argmax(out)).toBe(argmax(dry) + 160);
    expect(out.getChannelData(0)[argmax(out)]).toBeCloseTo(2 * (dry.getChannelData(0)[argmax(dry)] as number), 6);
  });

  it('mute and solo choose the branches that sound, and never change the timing', async () => {
    const { project, patternId, ins } = sineProject();
    const dry = await renderDocs([project], patternId, plugins);
    const two = withRack(project, ins[1]!, { branches: 2 }, (d, { rackId, branches }) => {
      addRackFx(d, ins[1]!, rackId, branches[0]!, instance(gainFx, { gain: 0.5 }));
      addRackFx(d, ins[1]!, rackId, branches[1]!, instance(latent375));
    });
    const [first, second] = two.mixer.inserts[ins[1]!]!.fx[0]!.rack!.branches.map((branch) => branch.id);
    const rackId = two.mixer.inserts[ins[1]!]!.fx[0]!.id;
    const level = (doc: Project) => renderDocs([doc], patternId, plugins).then((buffer) => rmsRange(buffer, 24000, 72000));
    const base = rmsRange(dry, 24000, 72000);
    expect((await level(two)) / base).toBeCloseTo(1.5, 2);
    const mutedFirst = produce(two, (d) => void setBranch(d, ins[1]!, rackId, first!, { muted: true }));
    expect((await level(mutedFirst)) / base).toBeCloseTo(1, 2);
    const soloSecond = produce(two, (d) => void setBranch(d, ins[1]!, rackId, second!, { solo: true }));
    expect((await level(soloSecond)) / base).toBeCloseTo(1, 2);
    const soloFirst = produce(two, (d) => void setBranch(d, ins[1]!, rackId, first!, { solo: true }));
    expect((await level(soloFirst)) / base).toBeCloseTo(0.5, 2);
    let latency = -1;
    await renderDocs([mutedFirst], patternId, plugins, { inspect: (engine) => (latency = latencyFrames(engine)) });
    expect(latency).toBe(375);
  });

  it('give each branch its level and pan', async () => {
    const { project, patternId, ins } = sineProject();
    const base = rmsRange(await renderDocs([project], patternId, plugins), 24000, 72000);
    const doc = withRack(project, ins[1]!, { branches: 2 }, (d, { rackId, branches }) => {
      setBranch(d, ins[1]!, rackId, branches[0]!, { levelDb: -6.0206, pan: -1 });
      setBranch(d, ins[1]!, rackId, branches[1]!, { levelDb: -60 });
    });
    const out = await renderDocs([doc], patternId, plugins);
    // A stereo pan is a balance: hard left folds the right channel into the left (a centred mono sound is twice as loud
    // there), and the branch is 6 dB down.
    expect(rmsRange(out, 24000, 72000, 0) / base).toBeCloseTo(1, 2);
    expect(rmsRange(out, 24000, 72000, 1)).toBeLessThan(1e-6);
  });
});

describe('idle and sleeping', () => {
  it('a rack asks of its insert only what the branches that sound need, and nothing for a branch that is muted', async () => {
    const { project, patternId, ins } = sineProject();
    const doc = withRack(project, ins[1]!, { branches: 2 }, (d, { rackId, branches }) => {
      addRackFx(d, ins[1]!, rackId, branches[0]!, instance(latent375));
      addRackFx(d, ins[1]!, rackId, branches[1]!, instance(latent160));
    });
    const rackId = doc.mixer.inserts[ins[1]!]!.fx[0]!.id;
    const [first, second] = doc.mixer.inserts[ins[1]!]!.fx[0]!.rack!.branches.map((branch) => branch.id);
    const needs = async (project: Project) => {
      let seen: { busy: boolean; tailSec: number } | null = null;
      await renderDocs([project], patternId, plugins, {
        inspect: (engine) => (seen = engine.mixer.strip(ins[1]!)!.slotStrips[0]!.idleNeeds()),
      });
      return seen as unknown as { busy: boolean; tailSec: number };
    };
    // Effects made of native nodes that cannot say they sleep are asked for silence at the input for as long as they ring.
    expect((await needs(doc)).tailSec).toBeGreaterThan(0);
    expect((await needs(doc)).busy).toBe(false);
    const bothMuted = produce(doc, (d) => {
      setBranch(d, ins[1]!, rackId, first!, { muted: true });
      setBranch(d, ins[1]!, rackId, second!, { muted: true });
    });
    expect(await needs(bothMuted)).toEqual({ busy: false, tailSec: 0 });
  });

  it('reports how many macro targets are hooked, and lets go of them when the mapping goes', async () => {
    const { project, patternId, ins } = sineProject();
    let rackId!: SlotId;
    const doc = withRack(project, ins[1]!, {}, (d, rack) => {
      rackId = rack.rackId;
      const fx = addRackFx(d, ins[1]!, rack.rackId, rack.branches[0]!, instance(gainFx))!;
      setMacroMapping(d, ins[1]!, rack.rackId, 0, { target: { kind: 'param', slotId: fx, paramId: 'gain' }, min: 0, max: 1, curve: 'linear' });
      setMacroMapping(d, ins[1]!, rack.rackId, 1, { target: { kind: 'mix', slotId: fx }, min: 0, max: 1, curve: 'linear' });
      setMacroMapping(d, ins[1]!, rack.rackId, 2, { target: { kind: 'gain' }, min: 0, max: -6, curve: 'linear' });
    });
    const linked: number[] = [];
    const count = (engine: Engine) => linked.push(engine.mixer.strip(ins[1]!)!.slotStrips[0]!.nestedEffect!.linkedTargets);
    await renderDocs([doc], patternId, plugins, { inspect: count });
    const cleared = produce(doc, (d) => void (d.mixer.inserts[ins[1]!]!.fx[0]!.rack!.macros[1]!.mappings = []));
    await renderDocs([doc, cleared], patternId, plugins, { inspect: count });
    expect(rackId).toBeDefined();
    expect(linked).toEqual([3, 2]);
  });
});

describe('frequency bands', () => {
  for (const bands of [2, 3, 4]) {
    it(`${bands} bands add up flat (within 0.1 dB from 30 Hz to 18 kHz)`, async () => {
      const { project, patternId, ins } = impulseProject();
      const dry = await renderDocs([project], patternId, plugins);
      const doc = withRack(project, ins[1]!, { split: 'bands', branches: bands });
      const out = await renderDocs([doc], patternId, plugins);
      const { min, max } = responseDb(out, dry, 30, 18000);
      expect(min).toBeGreaterThan(-0.1);
      expect(max).toBeLessThan(0.1);
    });
  }

  it('hand each band only its own frequencies', async () => {
    const { project, patternId, ins } = impulseProject();
    const dry = await renderDocs([project], patternId, plugins);
    const low = withRack(project, ins[1]!, { split: 'bands', branches: 2 }, (d, { rackId, branches }) => {
      setBranch(d, ins[1]!, rackId, branches[1]!, { muted: true });
    });
    const out = await renderDocs([low], patternId, plugins);
    // Well below the 500 Hz crossover the low band is the whole sound; at it, 6 dB down; three octaves above, almost nothing.
    expect(responseDb(out, dry, 40, 120).min).toBeGreaterThan(-0.1);
    expect(responseDb(out, dry, 40, 120).at(500)).toBeGreaterThan(-6.3);
    expect(responseDb(out, dry, 40, 120).at(500)).toBeLessThan(-5.7);
    expect(responseDb(out, dry, 4000, 8000).max).toBeLessThan(-30);
  });
});

describe('mid/side and left/right', () => {
  /** A noise-free stereo signal: two different sines, hard left and hard right. */
  function stereoProject() {
    const made = channelsProject([
      { def: sine, notes: [[0, BAR, 69]], insert: 1 },
      { def: sine, notes: [[0, BAR, 76]], insert: 1 },
    ]);
    const project = produce(made.project, (d) => {
      setChannelProp(d, made.channels[0]!, 'pan', -1);
      setChannelProp(d, made.channels[1]!, 'pan', 1);
    });
    return { ...made, project };
  }

  for (const split of ['midside', 'leftright'] as const) {
    it(`${split} with nothing in the branches gives the input back`, async () => {
      const { project, patternId, ins } = stereoProject();
      const dry = await renderDocs([project], patternId, plugins);
      const out = await renderDocs([withRack(project, ins[1]!, { split })], patternId, plugins);
      expect(rms(dry)).toBeGreaterThan(0.01);
      expect(maxDiff(out, dry)).toBeLessThan(1e-6);
    });
  }

  it('mid/side: silencing the side leaves both channels the same, silencing the mid leaves them opposite', async () => {
    const { project, patternId, channels, ins } = stereoProject();
    // Only the left channel sounds, so mid and side are each half of it.
    const leftOnly = produce(project, (d) => void setChannelProp(d, channels[1]!, 'volume', 0));
    const dry = await renderDocs([leftOnly], patternId, plugins);
    const noSide = produce(withRack(leftOnly, ins[1]!, { split: 'midside' }), (d) => {
      const rack = d.mixer.inserts[ins[1]!]!.fx[0]!;
      setBranch(d, ins[1]!, rack.id, rack.rack!.branches[1]!.id, { muted: true });
    });
    const mono = await renderDocs([noSide], patternId, plugins);
    const left = dry.getChannelData(0);
    for (let i = 24000; i < 24200; i++) {
      expect(mono.getChannelData(0)[i]).toBeCloseTo((left[i] as number) / 2, 6);
      expect(mono.getChannelData(1)[i]).toBeCloseTo((left[i] as number) / 2, 6);
    }
    const noMid = produce(withRack(leftOnly, ins[1]!, { split: 'midside' }), (d) => {
      const rack = d.mixer.inserts[ins[1]!]!.fx[0]!;
      setBranch(d, ins[1]!, rack.id, rack.rack!.branches[0]!.id, { muted: true });
    });
    const side = await renderDocs([noMid], patternId, plugins);
    for (let i = 24000; i < 24200; i++) {
      expect(side.getChannelData(0)[i]).toBeCloseTo((left[i] as number) / 2, 6);
      expect(side.getChannelData(1)[i]).toBeCloseTo(-(left[i] as number) / 2, 6);
    }
  });

  it('left/right: an effect on one branch changes that channel only', async () => {
    const { project, patternId, ins } = stereoProject();
    const dry = await renderDocs([project], patternId, plugins);
    const doc = withRack(project, ins[1]!, { split: 'leftright' }, (d, { rackId, branches }) => {
      addRackFx(d, ins[1]!, rackId, branches[1]!, instance(gainFx, { gain: 0.25 }));
    });
    const out = await renderDocs([doc], patternId, plugins);
    expect(rmsRange(out, 24000, 72000, 0)).toBeCloseTo(rmsRange(dry, 24000, 72000, 0), 6);
    expect(rmsRange(out, 24000, 72000, 1) / rmsRange(dry, 24000, 72000, 1)).toBeCloseTo(0.25, 3);
  });
});

describe('macros', () => {
  const base = async () => {
    const made = sineProject();
    const level = rmsRange(await renderDocs([made.project], made.patternId, plugins), 24000, 72000);
    return { ...made, level };
  };

  /** A rack with a gain effect, whose gain macro 1 sweeps over [min, max] with a curve; macro 1 is at `macro`. */
  function gainRack(
    project: Project,
    insertId: InsertId,
    macro: number,
    curve: 'linear' | 'exponential' | 'inverted' = 'linear',
    range = { min: 0, max: 1 },
  ) {
    let rackId!: SlotId;
    const doc = withRack(project, insertId, {}, (d, rack) => {
      rackId = rack.rackId;
      const fx = addRackFx(d, insertId, rack.rackId, rack.branches[0]!, instance(gainFx, { gain: 1 }))!;
      setMacroMapping(d, insertId, rack.rackId, 0, { target: { kind: 'param', slotId: fx, paramId: 'gain' }, ...range, curve });
      setPluginParam(d, { kind: 'fx', insertId, slotId: rack.rackId }, 'macro1', macro);
    });
    return { doc, rackId };
  }

  it('moves a mapped parameter between the range ends, by the curve', async () => {
    const { project, patternId, ins, level } = await base();
    const at = async (macro: number, curve: 'linear' | 'exponential' | 'inverted') =>
      rmsRange(await renderDocs([gainRack(project, ins[1]!, macro, curve).doc], patternId, plugins), 24000, 72000) / level;
    expect(await at(0, 'linear')).toBeLessThan(1e-4);
    expect(await at(0.25, 'linear')).toBeCloseTo(0.25, 3);
    expect(await at(1, 'linear')).toBeCloseTo(1, 3);
    expect(await at(0.5, 'exponential')).toBeCloseTo(0.25, 3);
    expect(await at(0.25, 'inverted')).toBeCloseTo(0.75, 3);
  });

  it('follows the macro when it is edited while the rack plays', async () => {
    const { project, patternId, ins, level } = await base();
    const first = gainRack(project, ins[1]!, 0.2);
    const edited = produce(first.doc, (d) => void setPluginParam(d, { kind: 'fx', insertId: ins[1]!, slotId: first.rackId }, 'macro1', 0.8));
    const out = await renderDocs([first.doc, edited], patternId, plugins);
    expect(rmsRange(out, 24000, 72000) / level).toBeCloseTo(0.8, 3);
  });

  it('is automated like any parameter: a ramp over two bars sweeps the mapped parameter smoothly', async () => {
    const one = heldNote(tone, 2);
    const { project: routed, insertId } = withInsert(one.project, [one.ch]);
    const { doc, rackId } = gainRack(routed, insertId, 0);
    const target = { kind: 'plugin', owner: { kind: 'fx', insertId, slotId: rackId }, paramId: 'macro1' } as const;
    const { project: automated } = automate(doc, target, [pt(0, 0), pt(2 * BAR, 1)], [{ start: 0, length: 2 * BAR, lane: 1 }]);
    const render = (project: Project) =>
      renderOffline(project, {
        plugins: resolver(tone, gainFx),
        view: { mode: 'song', patternId: one.pid, loop: null },
        bars: 2,
        sampleRate: SR,
        tail: 0.1,
      });
    const { buffer, preRoll } = await render(automated);
    const env = rmsEnvelope(buffer, 0.02 * SR, Math.round(preRoll * SR) + Math.round(0.0013 * SR));
    // The channel is at 0.78; the tone is a sine of 0.25.
    const full = (0.25 * 0.78) / Math.SQRT2;
    for (const t of [0.5, 1, 2, 3, 3.8]) expect((env[Math.round(t / 0.02)] as number) / full).toBeCloseTo((t + 0.01) / 4, 2);
    // A render is the same every time, automation and all.
    expect(maxDiff((await render(automated)).buffer, buffer)).toBe(0);
  });

  it('sweeps a branch level, and lets the parameter go back to its own value when the mapping is removed', async () => {
    const { project, patternId, ins, level } = await base();
    let rackId!: SlotId;
    const mapped = withRack(project, ins[1]!, { branches: 2 }, (d, rack) => {
      rackId = rack.rackId;
      setMacroMapping(d, ins[1]!, rack.rackId, 1, { target: { kind: 'branch', branchId: rack.branches[0]!, param: 'level' }, min: -60, max: 0, curve: 'linear' });
      setPluginParam(d, { kind: 'fx', insertId: ins[1]!, slotId: rack.rackId }, 'macro2', 1);
    });
    // Branch 1 follows the macro (full), branch 2 is the dry sound: together twice the level.
    const full = await renderDocs([mapped], patternId, plugins);
    expect(rmsRange(full, 24000, 72000) / level).toBeCloseTo(2, 2);
    const unmapped = produce(mapped, (d) => {
      d.mixer.inserts[ins[1]!]!.fx[0]!.rack!.macros[1]!.mappings = [];
      setBranch(d, ins[1]!, rackId, d.mixer.inserts[ins[1]!]!.fx[0]!.rack!.branches[0]!.id, { levelDb: -6.0206 });
    });
    const back = await renderDocs([mapped, unmapped], patternId, plugins);
    expect(rmsRange(back, 24000, 72000) / level).toBeCloseTo(1.5, 2);
  });

  it('can sweep a crossover of a band split', async () => {
    const { project, patternId, ins } = impulseProject();
    const dry = await renderDocs([project], patternId, plugins);
    const doc = withRack(project, ins[1]!, { split: 'bands', branches: 2 }, (d, rack) => {
      setMacroMapping(d, ins[1]!, rack.rackId, 0, { target: { kind: 'crossover', index: 0 }, min: 200, max: 3200, curve: 'linear' });
      setBranch(d, ins[1]!, rack.rackId, rack.branches[1]!, { muted: true });
      setPluginParam(d, { kind: 'fx', insertId: ins[1]!, slotId: rack.rackId }, 'macro1', 0.5);
    });
    const out = await renderDocs([doc], patternId, plugins);
    // Halfway along a log knob from 200 Hz to 3.2 kHz is 800 Hz, where the low band is 6 dB down.
    const at800 = responseDb(out, dry, 100, 200).at(800);
    expect(at800).toBeGreaterThan(-6.3);
    expect(at800).toBeLessThan(-5.7);
  });
});

describe('editing a rack while the engine runs', () => {
  it('putting a rack on and taking it off again gives the original sound back bit for bit', async () => {
    const { project, patternId, ins } = sineProject();
    const plain = await renderDocs([project], patternId, plugins);
    const racked = withRack(project, ins[1]!, { split: 'bands', branches: 3 }, (d, rack) => {
      addRackFx(d, ins[1]!, rack.rackId, rack.branches[0]!, instance(gainFx, { gain: 0.5 }));
    });
    const out = await renderDocs([project, racked, project], patternId, plugins);
    expect(maxDiff(out, plain)).toBe(0);
  });

  it('adds a branch and an effect to a rack that is already playing', async () => {
    const { project, patternId, ins } = sineProject();
    const base = rmsRange(await renderDocs([project], patternId, plugins), 24000, 72000);
    const one = withRack(project, ins[1]!, {});
    const more = produce(one, (d) => {
      const rack = d.mixer.inserts[ins[1]!]!.fx[0]!;
      const added = addBranch(d, ins[1]!, rack.id)!;
      addRackFx(d, ins[1]!, rack.id, added, instance(gainFx, { gain: 0.5 }));
    });
    const out = await renderDocs([one, more], patternId, plugins);
    expect(rmsRange(out, 24000, 72000) / base).toBeCloseTo(1.5, 2);
  });

  it('switching the split of a playing rack keeps the effects and their settings', async () => {
    const { project, patternId, ins } = sineProject();
    const base = rmsRange(await renderDocs([project], patternId, plugins), 24000, 72000);
    const one = withRack(project, ins[1]!, {}, (d, rack) => {
      addRackFx(d, ins[1]!, rack.rackId, rack.branches[0]!, instance(gainFx, { gain: 0.5 }));
    });
    const split = produce(one, (d) => void setRackSplit(d, ins[1]!, d.mixer.inserts[ins[1]!]!.fx[0]!.id, 'midside'));
    const out = await renderDocs([one, split], patternId, plugins);
    // A mono sine is all mid: the mid branch has the gain effect, the side has nothing to carry.
    expect(rmsRange(out, 24000, 72000) / base).toBeCloseTo(0.5, 2);
  });

  it('an effect in a rack whose plugin is not installed passes the sound through, and keeps its settings', async () => {
    const { project, patternId, ins } = sineProject();
    const empty = withRack(project, ins[1]!, { branches: 1 });
    const missing = withRack(project, ins[1]!, { branches: 1 }, (d, { rackId, branches }) => {
      addRackFx(d, ins[1]!, rackId, branches[0]!, makePluginInstance('user.not-installed', 3, { amount: 0.7 }));
    });
    const plain = await renderDocs([empty], patternId, plugins);
    const out = await renderDocs([missing], patternId, plugins);
    expect(maxDiff(out, plain)).toBe(0);
    expect(missing.mixer.inserts[ins[1]!]!.fx[0]!.rack!.branches[0]!.fx[0]!.plugin.params.amount).toBe(0.7);
  });

  it('renders the same every time', async () => {
    const { project, patternId, ins } = sineProject();
    const doc = withRack(project, ins[1]!, { split: 'bands', branches: 3 }, (d, rack) => {
      addRackFx(d, ins[1]!, rack.rackId, rack.branches[0]!, instance(latent375));
      addRackFx(d, ins[1]!, rack.rackId, rack.branches[1]!, instance(gainFx, { gain: 0.7 }));
      addRackFx(d, ins[1]!, rack.rackId, rack.branches[2]!, instance(latent160));
    });
    const first = await renderDocs([doc], patternId, plugins);
    const second = await renderDocs([doc], patternId, plugins);
    expect(maxDiff(first, second)).toBe(0);
    expect(rms(first)).toBeGreaterThan(0.001);
  });
});
