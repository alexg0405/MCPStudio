import { describe, expect, it } from 'vitest';
import type { ParamValue, PluginDef } from '@agstudio/sdk';
import { Engine } from '@engine/engine';
import fm from '../../src/plugins/builtin/fm';
import pluck from '../../src/plugins/builtin/pluck';
import sampler from '../../src/plugins/builtin/sampler';
import threeOsc from '../../src/plugins/builtin/three-osc';
import wavetable from '../../src/plugins/builtin/wavetable';
import { instrumentProject } from '../helpers/instruments';
import { resolver } from '../helpers/fixtures';

const SR = 48000;

/** Export padding (Engine.tailSeconds) of one channel of `def` with `params`. */
async function tailOf(def: PluginDef, params: Record<string, ParamValue>): Promise<number> {
  const { project } = instrumentProject(def, [{ at: 0, len: 0.5, key: 60 }], { params });
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate: SR });
  const engine = new Engine(ctx, { plugins: resolver(def) }, true);
  engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
  await engine.ready();
  const tail = engine.tailSeconds();
  await engine.dispose();
  return tail;
}

describe('instrument export tails follow the release setting', () => {
  // A note's tail is what is left after its key goes up: the longer the release, the longer the export must run.
  const cases: [string, PluginDef, Record<string, ParamValue>, number][] = [
    ['3xOsc', threeOsc as PluginDef, { release: 6 }, 6],
    ['3xOsc preset (1.5 s release)', threeOsc as PluginDef, { attack: 0.6, release: 1.5 }, 1.5],
    ['Wavetable', wavetable as PluginDef, { ampRelease: 9 }, 9],
    ['FM', fm as PluginDef, { op1Release: 9, op2Release: 9, op3Release: 9, op4Release: 9 }, 9],
    ['Pluck', pluck as PluginDef, { release: 3 }, 3],
  ];
  for (const [name, def, params, seconds] of cases) {
    it(`${name}: tail covers a ${seconds} s release`, async () => {
      expect(await tailOf(def, params)).toBeGreaterThanOrEqual(seconds);
    });
  }

  it('Sampler with the envelope on: the release (a note is never longer than its sample)', async () => {
    expect(await tailOf(sampler as PluginDef, { envelope: true, release: 3 })).toBeGreaterThanOrEqual(3);
    expect(await tailOf(sampler as PluginDef, { envelope: true, release: 0.01 })).toBeLessThan(1);
  });

  it('shorter releases keep the old padding (nothing gets shorter)', async () => {
    expect(await tailOf(wavetable as PluginDef, { ampRelease: 0.1 })).toBeGreaterThanOrEqual(4);
    expect(await tailOf(threeOsc as PluginDef, { release: 0.05 })).toBeGreaterThanOrEqual(1);
  });
});
