/**
 * Kit sounds are synthesized when something first needs them, not when a sampler channel is made, so a
 * project full of kit channels doesn't delay startup. An offline render (export) still gets its sound at the
 * first note, synchronously.
 */
import { describe, expect, it } from 'vitest';
import type { PluginDef } from '@agstudio/sdk';
import { Engine } from '@engine/engine';
import { SampleCache } from '@engine/samples';
import sampler from '../../src/plugins/builtin/sampler';
import { analyze, instrumentProject, kitRef, renderNotes, SR } from '../helpers/instruments';
import { resolver } from '../helpers/fixtures';

const def = sampler as PluginDef;

describe('sampler channels and kit sounds', () => {
  it('making the instrument does not synthesize its kit sound; the first note does', async () => {
    const cache = new SampleCache();
    const { project } = instrumentProject(def, [{ at: 0, len: 1, key: 60 }], { samples: { main: 'kit/kick' } });
    const key = SampleCache.keyOf(kitRef('kit/kick').source, SR);
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR, sampleRate: SR });
    const engine = new Engine(ctx, { plugins: resolver(def), sampleCache: cache }, true);
    engine.applyDocChange({ next: project, prev: project, patches: null, origin: 'load' });
    await engine.ready();
    expect(cache.has(key)).toBe(false);
    // Anything that asks for the sound makes it (here the engine's tail probe, which a note's release depends on).
    expect(engine.tailSeconds()).toBeGreaterThan(0);
    expect(cache.has(key)).toBe(true);
    await engine.dispose();
  });

  it('an offline render still plays the kit sound from its first note', async () => {
    const buffer = await renderNotes(def, [{ at: 0, len: 1, key: 60 }], { samples: { main: 'kit/kick' } });
    const heard = analyze(buffer);
    expect(heard.finite).toBe(true);
    expect(heard.peak).toBeGreaterThan(0.1);
  });
});
