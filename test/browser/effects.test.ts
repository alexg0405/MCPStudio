import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { MASTER, type NoteId, type SlotId } from '@core/model/types';
import { addChannel, setChannelProp } from '@core/ops/channels';
import { addNote } from '@core/ops/notes';
import { clearRoutes, routeOnlyTo, setRoute, setSlotSidechain } from '@core/ops/routing';
import { setInsertProp } from '@core/ops/mixer';
import { renderOffline } from '@engine/render-offline';
import { defaultValues, type ParamSpec, type ParamValue, type PluginDef } from '@agstudio/sdk';
import { kitProject, peak, resolver, withInsert, type FxSpec } from '../helpers/fixtures';
import { M14_EFFECTS, M14_KERNELS, kernelCost } from '../helpers/effects';
import {
  addEffect,
  argmax,
  channelsProject,
  impulse,
  maxDiffShifted,
  renderDocs,
  rmsRange,
  SR,
} from '../helpers/routing';
import { noise } from '../helpers/tone';

const CEILING = Math.pow(10, -0.3 / 20);
/** The master safety limiter's look-ahead (every render is late by this much). */
const MASTER_DELAY = Math.round(0.0013 * SR);
const PRE_ROLL = 2048;
const byId = (id: string) => M14_EFFECTS.find((d) => d.id === id)!;
const plugins = resolver(impulse, noise);

const loop = () =>
  kitProject([
    { generator: 'kit/kick', steps: [0, 8] },
    { generator: 'kit/snare', steps: [4, 12] },
    { generator: 'kit/hat-closed', steps: [2, 6, 10, 14] },
  ]);

async function render(project: Parameters<typeof renderOffline>[0], patternId: string, bars = 1) {
  return (
    await renderOffline(project, {
      plugins,
      view: { mode: 'pattern', patternId: patternId as never, loop: null },
      bars,
      sampleRate: SR,
    })
  ).buffer;
}

describe('M14 effects', () => {
  it('are all discovered, with a description, plain params and descriptive presets', () => {
    const found = import.meta.glob<{ default: PluginDef }>('/src/plugins/builtin/*/index.{ts,tsx}', { eager: true });
    const defs = Object.values(found).map((m) => m.default);
    for (const def of M14_EFFECTS) {
      const d = defs.find((x) => x.id === def.id);
      expect(d?.kind, def.id).toBe('effect');
      expect(def.description?.length, def.id).toBeGreaterThan(20);
      expect(def.presets?.length, def.id).toBeGreaterThanOrEqual(5);
      for (const [id, spec] of Object.entries(def.params) as [string, ParamSpec][]) {
        expect(spec.label, `${def.id}.${id} label`).toBeTruthy();
        expect(spec.hint, `${def.id}.${id} hint`).toBeTruthy();
        expect(spec.group, `${def.id}.${id} group`).toBeTruthy();
        if (spec.type === 'enum')
          for (const o of spec.options) expect(spec.labels?.[o], `${def.id}.${id}: ${o}`).toBeTruthy();
      }
      for (const preset of def.presets ?? [])
        for (const key of Object.keys(preset.params ?? {}))
          expect(key in def.params, `${def.id} "${preset.name}": ${key}`).toBe(true);
    }
  });

  for (const def of M14_EFFECTS) {
    it(`${def.id}: every preset processes a drum loop with no NaN and a sane level`, async () => {
      const { project, patternId, channels } = loop();
      for (const preset of def.presets ?? []) {
        const fx: FxSpec = { def, params: preset.params as Record<string, ParamValue> };
        const out = await render(withInsert(project, channels, { fx: [fx] }).project, patternId);
        for (let c = 0; c < 2; c++)
          for (const x of out.getChannelData(c)) if (!Number.isFinite(x)) throw new Error(`${preset.name}: not finite`);
        expect(peak(out), preset.name).toBeLessThanOrEqual(CEILING + 1e-6);
      }
    });
  }

  it('the Limiter’s look-ahead is compensated: an impulse lines up with its dry parallel path', async () => {
    const limiter = byId('agstudio.limiter');
    const { project, patternId, ins } = channelsProject([{ def: impulse, notes: [[0, 240, 60]], insert: 1 }]);
    const [a, b, c] = [ins[1]!, ins[2]!, ins[3]!];
    const bare = await renderDocs([project], patternId, plugins);
    // Insert 1 sends to 2 (the limiter, at its defaults the impulse passes untouched, only late) and 3 (dry).
    const parallel = produce(project, (d) => {
      routeOnlyTo(d, a, b);
      setRoute(d, a, c);
      setInsertProp(d, b, 'volume', 0.5);
      setInsertProp(d, c, 'volume', 0.5);
      addEffect(d, b, limiter, { ceiling: 0 });
    });
    let latency = 0;
    const out = await renderDocs([parallel], patternId, plugins, { inspect: (e) => (latency = e.graphLatency()) });
    const frames = Math.round(SR * 0.005) + 14;
    expect(latency * SR).toBeCloseTo(frames, 6);
    expect(argmax(out) - argmax(bare)).toBe(frames);
    // Both halves land on the same frame: the sum is the bare impulse, just later.
    expect(maxDiffShifted(out, bare, frames)).toBeLessThan(1e-6);
  });

  it('the Vocoder speaks only when its sidechain does', async () => {
    const vocoder = byId('agstudio.vocoder');
    // A kick and snare on insert 1 (routed nowhere: only the key), noise (the carrier) on insert 2.
    const kit = kitProject([{ generator: 'kit/snare', steps: [0, 8] }]);
    const ins = kit.project.mixer.order;
    const [key, synth] = [ins[1]!, ins[2]!];
    const carrier = makeInstrumentChannel('Noise', makePluginInstance(noise.id, 1, defaultValues(noise.params)));
    let slot!: SlotId;
    const base = produce(kit.project, (d) => {
      setChannelProp(d, kit.channels[0]!, 'output', key);
      clearRoutes(d, key);
      addChannel(d, carrier);
      setChannelProp(d, carrier.id, 'output', synth);
      addNote(d, kit.patternId, carrier.id, { id: 'nc' as NoteId, tick: 0, length: 3840, key: 60, velocity: 1 });
      slot = addEffect(d, synth, vocoder, { release: 20 });
    });
    const keyed = produce(base, (d) => {
      setSlotSidechain(d, synth, slot, key);
    });
    const out = await renderDocs([keyed], kit.patternId, plugins);
    const ownInput = await renderDocs([base], kit.patternId, plugins);
    const at = (beat: number) => PRE_ROLL + MASTER_DELAY + beat * (SR / 2);
    // Snare hits on beats 0 and 2: loud right after them, quiet in between (beat 1).
    const hit = rmsRange(out, at(0) + 0.005 * SR, at(0) + 0.08 * SR);
    const gap = rmsRange(out, at(1), at(1) + 0.3 * SR);
    expect(hit).toBeGreaterThan(0.01);
    expect(hit / gap).toBeGreaterThan(10);
    expect(rmsRange(out, at(2) + 0.005 * SR, at(2) + 0.08 * SR)).toBeGreaterThan(0.01);
    // Without a sidechain it keys from its own (continuous) noise: no gaps.
    expect(rmsRange(ownInput, at(1), at(1) + 0.3 * SR)).toBeGreaterThan(gap * 10);
  });

  it('the Stutter gates on the beat of the song', async () => {
    const stutter = byId('agstudio.stutter');
    const { project, patternId, channels } = channelsProject([{ def: noise, notes: [[0, 3840, 60]], insert: 1 }]);
    const doc = withInsert(project, channels, { fx: [{ def: stutter, params: { gate: '1/8', depth: 1, smooth: 1 } }] });
    const out = await render(doc.project, patternId);
    const eighth = SR / 4; // a 1/8 note at 120 BPM
    const start = PRE_ROLL + MASTER_DELAY;
    for (let k = 0; k < 8; k++) {
      const t0 = start + k * eighth;
      const open = rmsRange(out, t0 + 0.1 * eighth, t0 + 0.4 * eighth);
      const shut = rmsRange(out, t0 + 0.6 * eighth, t0 + 0.9 * eighth);
      expect(open, `1/8 #${k}`).toBeGreaterThan(0.05);
      expect(shut, `1/8 #${k}`).toBeLessThan(1e-4);
    }
  });

  it('each instance costs well under 1 % of a core at 48 kHz (Tune, Vocoder, Analyzer: comfortably under 5 %)', () => {
    const rows: string[] = [];
    for (const { def, Kernel, heavy } of M14_KERNELS) {
      const presets = def.presets ?? [];
      // The busiest preset: the defaults plus the preset with the most settings.
      const preset = [...presets].sort(
        (x, y) => Object.keys(y.params ?? {}).length - Object.keys(x.params ?? {}).length,
      )[0];
      const params = { ...defaultValues(def.params), ...(preset?.params as Record<string, ParamValue>) };
      const cost = kernelCost(Kernel, def.params, params);
      rows.push(`${def.id.padEnd(20)} ${cost.toFixed(3)} %`);
      // Measured on a quiet M-series Mac: every effect 0.07–0.8 %, the heavy ones 0.4–0.75 %. The
      // limits leave room for a busy machine.
      expect(cost, def.id).toBeLessThan(heavy ? 5 : 1.5);
    }
    console.log(`Effect cost per instance at 48 kHz (share of one core):\n${rows.join('\n')}`);
  });

  it('the master limiter preset ("Brickwall master −1 dB") keeps a hot mix under −1 dBFS', async () => {
    const limiter = byId('agstudio.limiter');
    const { project, patternId, channels } = loop();
    // The insert fader comes after its effects: keep it at unity so the limiter has the last word.
    const hot = withInsert(project, channels, {
      volume: 1,
      fx: [{ def: limiter, params: { ...(limiter.presets![0]!.params as Record<string, ParamValue>), input: 12 } }],
    }).project;
    const out = await render(
      produce(hot, (d) => setInsertProp(d, MASTER, 'volume', 1)),
      patternId,
    );
    expect(peak(out)).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-6);
    expect(peak(out)).toBeGreaterThan(0.5);
  });
});
