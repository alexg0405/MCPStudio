import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { MASTER, type InsertId, type Project, type SlotId } from '@core/model/types';
import { setChannelProp } from '@core/ops/channels';
import { removeInsert, setFxSlotEnabled, setInsertProp, toggleSoloInsert } from '@core/ops/mixer';
import { clearRoutes, routeOnlyTo, setRoute, setSlotSidechain } from '@core/ops/routing';
import { targetKey } from '@core/model/targets';
import { dbToGain } from '@agstudio/sdk';
import { makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import type { NoteId } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { addNote } from '@core/ops/notes';
import type { ParamValue, PluginDef } from '@agstudio/sdk';
import ducker from '../../src/plugins/builtin/ducker';
import { kitProject, maxDiff, peak, resolver, rms } from '../helpers/fixtures';
import {
  addEffect,
  argmax,
  channelsProject,
  countingSidechain,
  impulse,
  keyListener,
  latentEffect,
  maxDiffShifted,
  renderDocs,
  rmsRange,
  sine,
  SR,
} from '../helpers/routing';

const LATENT = 375; // 1/128 s at 48 kHz
const latent = latentEffect(LATENT);
const latent2 = latentEffect(160);
const plugins = resolver(impulse, sine, latent, latent2, keyListener);
const BAR = 3840;

/** A sine on insert 1 (routed to the master) for level measurements. */
function sineOnA() {
  return channelsProject([{ def: sine, notes: [[0, BAR, 69]], insert: 1 }]);
}

/** An impulse at tick 0 on insert 1. */
function impulseOnA() {
  return channelsProject([{ def: impulse, notes: [[0, 240, 60]], insert: 1 }]);
}

describe('routes', () => {
  it('a −6 dB send adds the expected energy at the target', async () => {
    const { project, patternId, ins } = sineOnA();
    const [a, b] = [ins[1]!, ins[2]!];
    const level = dbToGain(-6);
    const dry = await renderDocs([project], patternId, plugins);
    // Only the send: the target hears the source at the send level (energy × level²).
    const sendOnly = produce(project, (d) => {
      routeOnlyTo(d, a, b);
      setRoute(d, a, b, { level });
    });
    const target = await renderDocs([sendOnly], patternId, plugins);
    expect(rms(dry)).toBeGreaterThan(0.01);
    expect((rms(target) / rms(dry)) ** 2).toBeCloseTo(level ** 2, 5);
    expect(maxDiffShifted(target, dry, 0, level)).toBeLessThan(1e-6);
    // A parallel send adds coherently: 1 + level.
    const parallel = produce(project, (d) => {
      setRoute(d, a, b, { level });
    });
    const both = await renderDocs([parallel], patternId, plugins);
    expect(rms(both) / rms(dry)).toBeCloseTo(1 + level, 5);
    expect(maxDiffShifted(both, dry, 0, 1 + level)).toBeLessThan(1e-6);
  });

  it('chains through buses and drops routes to missing inserts', async () => {
    const { project, patternId, ins } = sineOnA();
    const [a, b, c] = [ins[1]!, ins[2]!, ins[3]!];
    const dry = await renderDocs([project], patternId, plugins);
    const chain = produce(project, (d) => {
      routeOnlyTo(d, a, b);
      routeOnlyTo(d, b, c);
      setInsertProp(d, c, 'volume', 0.5);
    });
    expect(maxDiffShifted(await renderDocs([chain], patternId, plugins), dry, 0, 0.5)).toBeLessThan(1e-6);
    // Written behind the ops' backs: a route to a missing insert carries nothing, and no route is silence.
    const dangling = produce(project, (d) => {
      d.mixer.inserts[a]!.routes = [{ to: 'ins_gone' as InsertId, level: 1, pre: false }];
    });
    expect(peak(await renderDocs([dangling], patternId, plugins))).toBe(0);
    const none = produce(project, (d) => clearRoutes(d, a));
    expect(peak(await renderDocs([none], patternId, plugins))).toBe(0);
  });

  it('pre-fader sends skip pan and fader but are muted with the insert', async () => {
    const { project, patternId, ins } = sineOnA();
    const [a, b] = [ins[1]!, ins[2]!];
    const dry = await renderDocs([project], patternId, plugins);
    const pre = produce(project, (d) => {
      routeOnlyTo(d, a, b);
      setRoute(d, a, b, { pre: true });
      setInsertProp(d, a, 'volume', 0);
      setInsertProp(d, a, 'pan', 1);
    });
    expect(maxDiff(await renderDocs([pre], patternId, plugins), dry)).toBeLessThan(1e-6);
    const post = produce(pre, (d) => {
      setRoute(d, a, b, { pre: false });
    });
    expect(peak(await renderDocs([post], patternId, plugins))).toBe(0);
    const muted = produce(pre, (d) => setInsertProp(d, a, 'muted', true));
    expect(peak(await renderDocs([muted], patternId, plugins))).toBe(0);
  });

  it('registers each send level and slot mix as an automatable target', async () => {
    const { project, patternId, ins } = sineOnA();
    const [a, b] = [ins[1]!, ins[2]!];
    let slot!: SlotId;
    const doc = produce(project, (d) => {
      setRoute(d, a, b, { level: 0.25 });
      slot = addEffect(d, b, latent2);
    });
    await renderDocs([doc], patternId, plugins, {
      inspect: (engine) => {
        const lane = engine.params.newest(targetKey({ kind: 'route', insertId: a, to: b }));
        expect(lane?.base).toBe(0.25);
        expect(engine.params.get(targetKey({ kind: 'route', insertId: a, to: MASTER }))).toHaveLength(1);
        expect(engine.params.newest(targetKey({ kind: 'slot', insertId: b, slotId: slot, param: 'mix' }))?.base).toBe(
          1,
        );
      },
    });
  });

  it('refuses loops: of a route cycle in a damaged document the first route in mixer order wins', async () => {
    const { project, patternId, ins } = sineOnA();
    const [a, b] = [ins[1]!, ins[2]!];
    const intended = produce(project, (d) => {
      routeOnlyTo(d, a, b);
    });
    const looped = produce(intended, (d) => {
      d.mixer.inserts[b]!.routes = [
        { to: a, level: 1, pre: false },
        { to: MASTER, level: 1, pre: false },
      ];
    });
    const expected = await renderDocs([intended], patternId, plugins);
    expect(peak(expected)).toBeGreaterThan(0.01);
    expect(maxDiff(await renderDocs([looped], patternId, plugins), expected)).toBe(0);
    // Edited into a loop and back, on a live engine.
    expect(maxDiff(await renderDocs([project, looped, intended], patternId, plugins), expected)).toBe(0);
  });
});

describe('delay compensation', () => {
  /** Insert 1 sends to 2 (a latent effect) and 3 (dry) at half level; both reach the master. */
  function parallel(project: Project, ins: InsertId[], fx = latent): Project {
    const [a, b, c] = [ins[1]!, ins[2]!, ins[3]!];
    return produce(project, (d) => {
      routeOnlyTo(d, a, b);
      setRoute(d, a, c);
      setInsertProp(d, b, 'volume', 0.5);
      setInsertProp(d, c, 'volume', 0.5);
      addEffect(d, b, fx);
    });
  }

  it('aligns an impulse through a latent effect with its dry parallel send', async () => {
    const { project, patternId, ins } = impulseOnA();
    const bare = await renderDocs([project], patternId, plugins);
    let latency = -1;
    const out = await renderDocs([parallel(project, ins)], patternId, plugins, {
      inspect: (engine) => {
        latency = engine.graphLatency();
        const pdc = engine.mixer.compensation!;
        expect(pdc.out(ins[2]!)).toBe(LATENT);
        expect(pdc.routePad(ins[3]!, MASTER)).toBe(LATENT);
      },
    });
    const i0 = argmax(bare);
    expect(argmax(out) - i0).toBe(LATENT);
    expect(latency).toBe(LATENT / SR);
    // Both halves land on the same frame: the sum is the bare impulse, just later.
    expect(Math.abs(out.getChannelData(0)[i0]!)).toBe(0);
    expect(maxDiffShifted(out, bare, LATENT)).toBe(0);
  });

  it('pads channels on the master, counts the master’s own effects and series latencies', async () => {
    const { project, patternId, ins } = channelsProject([
      { def: impulse, notes: [[0, 240, 60]], insert: 1 },
      { def: impulse, notes: [[0, 240, 60]], insert: 0 },
    ]);
    const [a, b] = [ins[1]!, ins[2]!];
    const doc = produce(project, (d) => {
      routeOnlyTo(d, a, b);
      addEffect(d, a, latent2);
      addEffect(d, b, latent);
      addEffect(d, MASTER, latent2);
      setInsertProp(d, MASTER, 'volume', 0.5);
    });
    const bare = await renderDocs(
      [produce(project, (d) => setInsertProp(d, MASTER, 'volume', 0.5))],
      patternId,
      plugins,
    );
    let latency = 0;
    const out = await renderDocs([doc], patternId, plugins, { inspect: (e) => (latency = e.graphLatency()) });
    expect(latency * SR).toBeCloseTo(160 + LATENT + 160, 6);
    expect(maxDiffShifted(out, bare, 160 + LATENT + 160)).toBe(0);
  });

  it('a bypassed latent slot stays bit-exact dry and adds no latency', async () => {
    const { project, patternId, ins } = impulseOnA();
    let slot!: SlotId;
    const withFx = produce(project, (d) => {
      slot = addEffect(d, ins[1]!, latent);
    });
    const bypassed = produce(withFx, (d) => setFxSlotEnabled(d, ins[1]!, slot, false));
    let latency = -1;
    const out = await renderDocs([bypassed], patternId, plugins, { inspect: (e) => (latency = e.graphLatency()) });
    expect(latency).toBe(0);
    expect(maxDiff(out, await renderDocs([project], patternId, plugins))).toBe(0);
    // Enabling it on a live engine brings the latency back.
    const back = await renderDocs([bypassed, withFx], patternId, plugins, {
      inspect: (e) => (latency = e.graphLatency()),
    });
    expect(latency).toBe(LATENT / SR);
    expect(argmax(back) - argmax(out)).toBe(LATENT);
  });

  it('recomputes when routing changes on a live engine (and on undo of an insert deletion)', async () => {
    const { project, patternId, ins } = impulseOnA();
    const doc = parallel(project, ins);
    const expected = await renderDocs([doc], patternId, plugins);
    const deleted = produce(doc, (d) => removeInsert(d, ins[2]!));
    const afterDelete = await renderDocs([doc, deleted], patternId, plugins);
    expect(maxDiff(afterDelete, await renderDocs([deleted], patternId, plugins))).toBe(0);
    expect(argmax(afterDelete)).toBe(argmax(await renderDocs([project], patternId, plugins)));
    expect(maxDiff(await renderDocs([doc, deleted, doc], patternId, plugins), expected)).toBe(0);
  });
});

describe('sidechains', () => {
  it('feeds the chosen track’s sidechain tap to the effect, aligned, or else its own input', async () => {
    // A kick-like impulse on insert 1 (no route: silent on its own), a sine on insert 2 with a key listener.
    const { project, patternId, ins } = channelsProject([
      { def: impulse, notes: [[0, 240, 60]], insert: 1 },
      { def: sine, notes: [[0, BAR, 69]], insert: 2 },
    ]);
    const [a, b] = [ins[1]!, ins[2]!];
    let slot!: SlotId;
    const silentKick = produce(project, (d) => {
      clearRoutes(d, a);
      slot = addEffect(d, b, keyListener);
    });
    // No source chosen: the listener hears its own input (the sine).
    const own = await renderDocs([silentKick], patternId, plugins);
    const sineOnly = await renderDocs([produce(project, (d) => clearRoutes(d, a))], patternId, plugins);
    expect(maxDiff(own, sineOnly)).toBe(0);
    // Keyed by insert 1: only the impulse comes out, even though insert 1 routes nowhere.
    const keyed = produce(silentKick, (d) => {
      setSlotSidechain(d, b, slot, a);
    });
    const heard = await renderDocs([keyed], patternId, plugins);
    const impulseAlone = await renderDocs(
      [produce(project, (d) => setChannelProp(d, d.channelOrder[1]!, 'muted', true))],
      patternId,
      plugins,
    );
    expect(maxDiff(heard, impulseAlone)).toBe(0);
    // A latent effect on the key's track holds the listening track back so they stay aligned.
    const latentKick = produce(keyed, (d) => {
      addEffect(d, a, latent);
    });
    let arrival = -1;
    const late = await renderDocs([latentKick], patternId, plugins, {
      inspect: (e) => (arrival = e.mixer.compensation!.arrival(b)),
    });
    expect(arrival).toBe(LATENT);
    expect(maxDiffShifted(late, heard, LATENT)).toBe(0);
  });

  it('a kick-sidechained ducker lowers the bass on every hit', async () => {
    // Four-on-the-floor kick on insert 1, a steady bass (sine) on insert 2 with the Ducker keyed by insert 1.
    const kit = kitProject([{ generator: 'kit/kick', steps: [0, 4, 8, 12] }]);
    const ins = kit.project.mixer.order;
    const [kick, bass] = [ins[1]!, ins[2]!];
    const bassCh = makeInstrumentChannel('Bass', makePluginInstance(sine.id, 1, { level: 0.3 }));
    let slot!: SlotId;
    const base = produce(kit.project, (d) => {
      setChannelProp(d, kit.channels[0]!, 'output', kick);
      addChannel(d, bassCh);
      setChannelProp(d, bassCh.id, 'output', bass);
      addNote(d, kit.patternId, bassCh.id, { id: 'nb' as NoteId, tick: 0, length: BAR, key: 33, velocity: 1 });
      clearRoutes(d, kick); // only the bass is heard; the kick still keys the ducker
      slot = addEffect(d, bass, ducker as PluginDef, ducker.presets![0]!.params as Record<string, ParamValue>);
    });
    const keyed = produce(base, (d) => {
      setSlotSidechain(d, bass, slot, kick);
    });
    const dry = await renderDocs(
      [produce(base, (d) => setFxSlotEnabled(d, bass, slot, false))],
      kit.patternId,
      plugins,
    );
    const out = await renderDocs([keyed], kit.patternId, plugins);
    const beat = SR / 2;
    const start = 2048;
    for (let hit = 0; hit < 4; hit++) {
      const at = start + hit * beat;
      const onHit = (b: AudioBuffer) => rmsRange(b, at + 0.005 * SR, at + 0.06 * SR);
      const between = (b: AudioBuffer) => rmsRange(b, at + 0.35 * SR, at + 0.48 * SR);
      expect(onHit(out) / onHit(dry)).toBeLessThan(0.4);
      expect(between(out) / between(dry)).toBeGreaterThan(0.97);
    }
    expect(rms(out)).toBeLessThan(rms(dry) * 0.9);
  });

  it('takes the key before the mute/solo gate', async () => {
    const { project, patternId, ins } = channelsProject([
      { def: impulse, notes: [[0, 240, 60]], insert: 1 },
      { def: sine, notes: [[0, BAR, 69]], insert: 2 },
    ]);
    const [a, b] = [ins[1]!, ins[2]!];
    const keyed = produce(project, (d) => {
      const slot = addEffect(d, b, keyListener);
      setSlotSidechain(d, b, slot, a);
      clearRoutes(d, a);
    });
    const heard = await renderDocs([keyed], patternId, plugins);
    expect(peak(heard)).toBeGreaterThan(0.3);
    const muted = produce(keyed, (d) => setInsertProp(d, a, 'muted', true));
    expect(maxDiff(await renderDocs([muted], patternId, plugins), heard)).toBe(0);
    const soloed = produce(keyed, (d) => toggleSoloInsert(d, b));
    expect(maxDiff(await renderDocs([soloed], patternId, plugins), heard)).toBe(0);
  });

  it('changing a sidechain only rewires (the effect is never recreated)', async () => {
    const { def, stats } = countingSidechain();
    const { project, patternId, ins } = sineOnA();
    const [a, b, c] = [ins[1]!, ins[2]!, ins[3]!];
    let slot!: SlotId;
    const base = produce(project, (d) => {
      slot = addEffect(d, a, def);
    });
    const docs = [
      base,
      produce(base, (d) => {
        setSlotSidechain(d, a, slot, b);
      }),
      produce(base, (d) => {
        setSlotSidechain(d, a, slot, c);
      }),
      base,
    ];
    await renderDocs(docs, patternId, resolver(sine, def));
    expect(stats).toEqual({ created: 1, disposed: 1, keyed: 1 }); // disposed with the engine
  });

  it('drops a sidechain that would loop (routes win)', async () => {
    const { project, patternId, ins } = sineOnA();
    const [a, b] = [ins[1]!, ins[2]!];
    let slot!: SlotId;
    const base = produce(project, (d) => {
      routeOnlyTo(d, a, b);
      slot = addEffect(d, a, keyListener);
    });
    // a → b by route; a slot on a keyed by b would close a loop: it keys from its own input.
    const looped = produce(base, (d) => {
      d.mixer.inserts[a]!.fx.find((s) => s.id === slot)!.sidechain = b;
    });
    expect(maxDiff(await renderDocs([looped], patternId, plugins), await renderDocs([base], patternId, plugins))).toBe(
      0,
    );
  });
});

describe('solo', () => {
  /** Sine A (insert 1) through bus 2; sine B (insert 3, an octave up) to the master; insert 4 feeds 1. */
  function busProject() {
    const { project, patternId, channels, ins } = channelsProject([
      { def: sine, notes: [[0, BAR, 69]], insert: 1 },
      { def: sine, notes: [[0, BAR, 81]], insert: 3 },
      { def: sine, notes: [[0, BAR, 76]], insert: 4 },
    ]);
    const doc = produce(project, (d) => {
      routeOnlyTo(d, ins[1]!, ins[2]!);
      routeOnlyTo(d, ins[4]!, ins[1]!);
    });
    return { doc, patternId, channels, ins };
  }

  it('a soloed insert plays with its sources and its path to the master; the rest is silenced', async () => {
    const { doc, patternId, channels, ins } = busProject();
    const soloed = await renderDocs([produce(doc, (d) => toggleSoloInsert(d, ins[1]!))], patternId, plugins);
    const others = await renderDocs(
      [produce(doc, (d) => setChannelProp(d, channels[1]!, 'muted', true))],
      patternId,
      plugins,
    );
    expect(rms(soloed)).toBeGreaterThan(0.01);
    expect(maxDiff(soloed, others)).toBe(0);
    // Soloing the bus keeps everything routed into it.
    const bus = await renderDocs([produce(doc, (d) => toggleSoloInsert(d, ins[2]!))], patternId, plugins);
    expect(maxDiff(bus, others)).toBe(0);
  });
});
