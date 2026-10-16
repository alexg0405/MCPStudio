import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { makePluginInstance } from '@core/model/defaults';
import { MASTER, type InsertId, type PatternId, type PluginOwner, type Project } from '@core/model/types';
import { addFxSlot, moveFxSlot, removeFxSlot, removeInsert, replaceFxPlugin, setFxSlotEnabled } from '@core/ops/mixer';
import type { EngineOptions } from '@engine/api';
import { Engine } from '@engine/engine';
import { defaultValues, defineEffect, p, type PluginDef } from '@agstudio/sdk';
import { EFFECTS, kitProject, maxDiff, resolver, withInsert } from '../helpers/fixtures';

const SR = 48000;
const byId = (id: string) => EFFECTS.find((d) => d.id === id)!;

/** An effect that counts how often it is created and disposed. */
function counting() {
  const stats = { created: 0, disposed: 0 };
  const def = defineEffect({
    id: 'test.count',
    name: 'Count',
    version: 1,
    params: { gain: p.float(0, 2, 1) },
    create({ audioContext: ac, params }) {
      stats.created++;
      const g = new GainNode(ac);
      params.gain.bind(g.gain);
      return {
        input: g,
        output: g,
        dispose() {
          stats.disposed++;
          g.disconnect();
        },
      };
    },
  });
  return { def, stats };
}

const loop = () =>
  kitProject([
    { generator: 'kit/kick', steps: [0, 8] },
    { generator: 'kit/snare', steps: [4, 12] },
    { generator: 'kit/hat-closed', steps: [2, 6, 10, 14] },
  ]);

function load(engine: Engine, project: Project): void {
  engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
}

function edit(engine: Engine, prev: Project, next: Project): Project {
  engine.applyDocChange({ next, prev, patches: [], origin: 'edit' });
  return next;
}

/** Applies each document in turn to one offline engine, then renders a bar (notes scheduled up front). */
async function renderAfter(docs: Project[], patternId: PatternId, opts: Partial<EngineOptions> = {}) {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR * 3, sampleRate: SR });
  const engine = new Engine(ctx, { plugins: resolver(), ...opts }, true);
  let prev: Project | null = null;
  for (const next of docs) {
    if (prev) edit(engine, prev, next);
    else load(engine, next);
    prev = next;
  }
  engine.setTransportView({ mode: 'pattern', patternId, loop: null });
  await engine.ready();
  const preRoll = 2048 / SR;
  engine.startOffline(0, preRoll);
  engine.pumpOffline(preRoll + engine.barSeconds() - 1e-6);
  await engine.syncWorklets();
  const buffer = await ctx.startRendering();
  await engine.dispose();
  return buffer;
}

describe('engine mixer reconcile', () => {
  it('keys slots by id: moving and toggling rewire, only removal or a new plugin rebuilds', async () => {
    const { def, stats } = counting();
    const { project, channels } = loop();
    const base = withInsert(project, channels, { fx: [{ def }, { def }, { def }] });
    const { insertId, slots } = base;
    const [s0, s1, s2] = slots as [(typeof slots)[0], (typeof slots)[0], (typeof slots)[0]];
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate: SR });
    const engine = new Engine(ctx, { plugins: resolver(def as PluginDef) }, true);
    load(engine, base.project);
    await engine.ready();
    expect(stats).toEqual({ created: 3, disposed: 0 });

    let doc = edit(
      engine,
      base.project,
      produce(base.project, (d) => moveFxSlot(d, insertId, s0, 2)),
    );
    doc = edit(
      engine,
      doc,
      produce(doc, (d) => setFxSlotEnabled(d, insertId, s1, false)),
    );
    await engine.ready();
    expect(stats).toEqual({ created: 3, disposed: 0 });

    doc = edit(
      engine,
      doc,
      produce(doc, (d) => removeFxSlot(d, insertId, s1)),
    );
    expect(stats).toEqual({ created: 3, disposed: 1 });

    // Same plugin, fresh data: params change in place.
    const again = makePluginInstance(def.id, def.version, { gain: 0.5 });
    doc = edit(
      engine,
      doc,
      produce(doc, (d) => replaceFxPlugin(d, insertId, s2, again)),
    );
    await engine.ready();
    expect(stats).toEqual({ created: 3, disposed: 1 });

    // A different plugin replaces the instance.
    const eq = byId('agstudio.eq');
    const eqData = makePluginInstance(eq.id, eq.version, defaultValues(eq.params));
    doc = edit(
      engine,
      doc,
      produce(doc, (d) => replaceFxPlugin(d, insertId, s2, eqData)),
    );
    await engine.ready();
    expect(stats).toEqual({ created: 3, disposed: 2 });

    // Hot reload rebuilds the instances that use the plugin.
    engine.pluginsChanged([def.id]);
    await engine.ready();
    expect(stats).toEqual({ created: 4, disposed: 3 });

    // Deleting the insert disposes what is left.
    edit(
      engine,
      doc,
      produce(doc, (d) => removeInsert(d, insertId)),
    );
    expect(stats).toEqual({ created: 4, disposed: 4 });
    await engine.dispose();
  });

  it('rewires a reordered chain to exactly what a fresh engine builds', async () => {
    const { project, patternId, channels } = loop();
    const eq = { def: byId('agstudio.eq'), params: { lowFreq: 300, lowGain: 18 } };
    const dist = { def: byId('agstudio.distortion'), params: { drive: 20, curve: 'hard' } };
    const ab = withInsert(project, channels, { fx: [eq, dist] });
    const ba = produce(ab.project, (d) => moveFxSlot(d, ab.insertId, ab.slots[0]!, 1));
    const fresh = await renderAfter([ba], patternId);
    const moved = await renderAfter([ab.project, ba], patternId);
    const original = await renderAfter([ab.project], patternId);
    expect(maxDiff(moved, fresh)).toBeLessThan(1e-6);
    expect(maxDiff(original, fresh)).toBeGreaterThan(1e-3);
  });

  it('moves channels off a deleted insert and back on undo', async () => {
    const { project, patternId, channels } = loop();
    const routed = withInsert(project, channels, { index: 3, volume: 0.5 });
    const deleted = produce(routed.project, (d) => removeInsert(d, routed.insertId));
    const viaMaster = await renderAfter([routed.project, deleted], patternId);
    expect(maxDiff(viaMaster, await renderAfter([project], patternId))).toBeLessThan(1e-6);
    const restored = await renderAfter([routed.project, deleted, routed.project], patternId);
    expect(maxDiff(restored, await renderAfter([routed.project], patternId))).toBeLessThan(1e-6);
  });

  it('passes audio through a missing or failing effect and reports it', async () => {
    const broken = defineEffect({
      id: 'test.broken',
      name: 'Broken',
      version: 1,
      params: {},
      create() {
        throw new Error('nope');
      },
    });
    const faults: [PluginOwner, string, unknown][] = [];
    const { project, patternId, channels } = loop();
    const bare = withInsert(project, channels).project;
    const bad = produce(bare, (d) => {
      const ins = d.mixer.order[1] as InsertId;
      addFxSlot(d, ins, makePluginInstance('user.not-installed', 1, {}));
      addFxSlot(d, ins, makePluginInstance(broken.id, 1, {}));
    });
    const out = await renderAfter([bad], patternId, {
      plugins: resolver(broken as PluginDef),
      onPluginFault: (owner, id, err) => faults.push([owner, id, err]),
    });
    expect(maxDiff(out, await renderAfter([bare], patternId))).toBe(0);
    expect(faults.map(([owner, id]) => [owner.kind, id])).toEqual([
      ['fx', 'user.not-installed'],
      ['fx', 'test.broken'],
    ]);
    expect(faults[0]![2]).toBe('missing');
  });

  it('counts effect tails for export, except bypassed ones', () => {
    const { project, channels } = loop();
    const reverb = byId('agstudio.reverb');
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate: SR });
    const engine = new Engine(ctx, { plugins: resolver() }, true);
    const on = withInsert(project, channels, { fx: [{ def: reverb, params: { decay: 4, preDelay: 0.05 } }] });
    load(engine, on.project);
    return engine.ready().then(async () => {
      expect(engine.tailSeconds()).toBeGreaterThan(5);
      edit(
        engine,
        on.project,
        produce(on.project, (d) => setFxSlotEnabled(d, on.insertId, on.slots[0]!, false)),
      );
      expect(engine.tailSeconds()).toBeLessThan(2);
      await engine.dispose();
    });
  });
});

describe('meters', () => {
  it('reads each insert’s left/right peak in mixer order', async () => {
    const { project, patternId, channels } = kitProject([{ generator: 'kit/snare', steps: [0] }]);
    const routed = withInsert(project, channels, { index: 2 }).project;
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR / 2, sampleRate: SR });
    // A non-offline engine on an offline context: meters exist, rendering stays deterministic.
    const engine = new Engine(ctx, { plugins: resolver() }, false);
    load(engine, routed);
    engine.setTransportView({ mode: 'pattern', patternId, loop: null });
    await engine.ready();
    engine.startOffline(0, 0.01);
    engine.pumpOffline(0.3);
    const order = [...routed.mixer.order, 'ins_unknown' as InsertId];
    const out = new Float32Array(order.length * 2).fill(-1);
    const short = new Float32Array(3);
    // The meters only join the graph once someone reads them (the mixer's first frame): the first read is 0.
    engine.readMeters(order, out);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
    out.fill(-1);
    let read: number[] = [];
    void ctx.suspend(0.06).then(() => {
      engine.readMeters(order, out);
      engine.readMeters(order, short);
      read = Array.from(out);
      void ctx.resume();
    });
    await ctx.startRendering();
    await engine.dispose();
    const [masterL, masterR, , , insL, insR] = read as number[];
    expect(insL).toBeGreaterThan(0.01);
    expect(insR).toBeCloseTo(insL!, 6);
    expect(masterL).toBeCloseTo(insL!, 5);
    expect(masterR).toBeCloseTo(insR!, 5);
    // Every other insert (and the unknown id) reads silence.
    read.forEach((v, i) => {
      if (i > 1 && (i < 4 || i > 5)) expect(v).toBe(0);
    });
    expect(order[0]).toBe(MASTER);
  });

  it('keeps the meter analysers out of the graph until they are read, and drops them again when nobody looks', async () => {
    const { project } = kitProject([{ generator: 'kit/snare', steps: [0] }]);
    const engine = Engine.realtime({ plugins: resolver() });
    load(engine, project);
    await engine.ready();
    const master = engine.mixer.strip(MASTER)!;
    // A closed mixer costs nothing.
    expect(master.metering).toBe(false);
    const out = new Float32Array(2);
    engine.readMeters([MASTER], out);
    expect(master.metering).toBe(true);
    // Read every frame: stays; left alone for a few seconds: gone.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      engine.readMeters([MASTER], out);
    }
    expect(master.metering).toBe(true);
    await new Promise((r) => setTimeout(r, 3200));
    expect(master.metering).toBe(false);
    engine.readMeters([MASTER], out);
    expect(master.metering).toBe(true);
    await engine.dispose();
  }, 20_000);
});
