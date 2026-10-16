/**
 * Long loops must not leak: the number of audio graph connections, scheduler bookkeeping and
 * automation segments stay flat over dozens of loop passes (graph voices disposed, clip players
 * released, listeners removed).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { Project } from '@core/model/types';
import { addChannel } from '@core/ops/channels';
import { addNotes } from '@core/ops/notes';
import { Engine } from '@engine/engine';
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import fm from '../../src/plugins/builtin/fm';
import threeOsc from '../../src/plugins/builtin/three-osc';
import { kitProject, resolver } from '../helpers/fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Counts live connections between audio nodes (connect/disconnect on every node type). */
function countEdges() {
  const edges = new Map<object, Set<object>>();
  let total = 0;
  const proto = AudioNode.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const connect = proto.connect as (...a: unknown[]) => unknown;
  const disconnect = proto.disconnect as (...a: unknown[]) => unknown;
  proto.connect = function (this: object, ...args: unknown[]) {
    const to = args[0] as object;
    let set = edges.get(this);
    if (!set) edges.set(this, (set = new Set()));
    if (!set.has(to)) {
      set.add(to);
      total++;
    }
    return connect.apply(this, args);
  };
  proto.disconnect = function (this: object, ...args: unknown[]) {
    const set = edges.get(this);
    if (set) {
      if (args.length === 0 || typeof args[0] === 'number') {
        total -= set.size;
        set.clear();
      } else if (set.delete(args[0] as object)) total--;
    }
    return disconnect.apply(this, args);
  };
  return {
    get total() {
      return total;
    },
    restore() {
      proto.connect = connect;
      proto.disconnect = disconnect;
    },
  };
}

let engine: Engine | null = null;
afterEach(async () => {
  await engine?.dispose();
  engine = null;
});

function song(): { project: Project; patternId: string } {
  const { project: kit, patternId } = kitProject([{ generator: 'kit/kick', steps: [0, 2, 4, 6] }], 240);
  const project = produce(kit, (d) => {
    for (const def of [threeOsc, fm] as PluginDef[]) {
      const ch = makeInstrumentChannel(def.id, makePluginInstance(def.id, def.version, defaultValues(def.params)));
      addChannel(d, ch);
      const notes = [60, 64, 67].map((key, i) => ({ id: newId.note(), tick: i * 240, length: 200, key, velocity: 0.8 }));
      addNotes(d, patternId, ch.id, notes);
    }
  });
  return { project, patternId };
}

describe('engine memory', () => {
  it('a short loop played dozens of times leaves the audio graph and the scheduler as it was', async () => {
    const { project, patternId } = song();
    const edges = countEdges();
    try {
      engine = Engine.realtime({ plugins: resolver(threeOsc, fm) });
      engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
      // A quarter of a bar at 240 BPM: 0.25 s a pass.
      engine.setTransportView({ mode: 'pattern', patternId: patternId as never, loop: null });
      await engine.resume();
      await engine.ready();
      const internals = engine as unknown as {
        transport: { pendingNotes: number; segs: unknown[] };
        ports: Set<unknown>;
        params: { keys(): IterableIterator<string> };
      };
      const idle = edges.total;
      const ports = internals.ports.size;
      const paramKeys = [...internals.params.keys()].length;
      engine.play(0);
      const sample = async (ms: number) => {
        const end = performance.now() + ms;
        let min = Infinity;
        let max = 0;
        let pending = 0;
        while (performance.now() < end) {
          min = Math.min(min, edges.total);
          max = Math.max(max, edges.total);
          pending = Math.max(pending, internals.transport.pendingNotes);
          await sleep(25);
        }
        return { min, max, pending };
      };
      const early = await sample(3000);
      await sleep(15_000); // about 60 passes
      const late = await sample(3000);
      // The bar (2 s at 240 BPM) played ~8 times early and ~70 times by the end.
      expect(late.max).toBeLessThanOrEqual(early.max + 12);
      expect(late.min).toBeLessThanOrEqual(early.min + 12);
      expect(late.pending).toBeLessThanOrEqual(early.pending + 8);
      expect(internals.transport.segs.length).toBeLessThan(200);
      expect(internals.ports.size).toBe(ports);
      expect([...internals.params.keys()].length).toBe(paramKeys);
      engine.stop();
      // Voices are let go once their release is over.
      await sleep(3500);
      expect(edges.total).toBeLessThanOrEqual(idle + 12);
    } finally {
      edges.restore();
    }
  }, 60_000);
});
